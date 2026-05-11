// =============================================================================
// Cron Scheduler Service
// Polling scheduler that checks every 60 seconds which cron-enabled systems
// need to run, then fires their executions via trigger-executor.
// =============================================================================

import { CronExpressionParser } from 'cron-parser';
import { pool } from '../db';
import { runTriggerExecution } from './trigger-executor';
import { DeploymentRecord, TriggerPattern } from '../types/registry';
import { CronTriggerConfig } from './trigger-factory';

const POLL_INTERVAL_MS = 60_000; // 60 seconds
const LOG_PREFIX = '[cron-scheduler]';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface ScheduledSystem {
  slug: string;
  deploymentId: string;
  expression: string;
  timezone: string;
  lastRanAt: Date | null;
  nextRunAt: Date;
}

export interface ScheduleStatusEntry {
  slug: string;
  expression: string;
  timezone: string;
  lastRanAt: string | null;
  nextRunAt: string;
  enabled: boolean;
}

// DB row shape for cron-enabled deployments
interface CronDeploymentRow {
  id: string;
  system_slug: string;
  trigger_config: unknown;
  cron_last_ran_at: string | null;
  cron_next_run_at: string | null;
}

// Full deployment row for execution (matches registry pattern)
interface DeploymentRow {
  id: string;
  system_name: string;
  system_slug: string;
  manifest_json: unknown;
  canvas_json: unknown;
  openclaw_config: unknown;
  trigger_type: string;
  trigger_config: unknown;
  pm2_process_name: string;
  secrets_encrypted: string | null;
  status: string;
  domain: string | null;
  tags: string[] | null;
  deployed_at: string;
  created_at: string;
  updated_at: string;
}

// -----------------------------------------------------------------------------
// In-memory schedule state
// -----------------------------------------------------------------------------

const scheduleMap = new Map<string, ScheduledSystem>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Initialize the cron scheduler: load all cron-enabled deployments from DB,
 * compute next run times, and start the polling timer.
 */
export async function initCronScheduler(): Promise<void> {
  try {
    const { rows } = await pool.query<CronDeploymentRow>(
      `SELECT id, system_slug, trigger_config, cron_last_ran_at, cron_next_run_at
       FROM deployments
       WHERE trigger_type = 'cron'
         AND status = 'deployed'
         AND (trigger_config->>'enabled')::boolean = true`
    );

    for (const row of rows) {
      const config = row.trigger_config as CronTriggerConfig;
      if (!config.expression) continue;

      try {
        const nextRunAt = computeNextRun(
          config.expression,
          config.timezone,
          row.cron_last_ran_at ? new Date(row.cron_last_ran_at) : null
        );

        scheduleMap.set(row.system_slug, {
          slug: row.system_slug,
          deploymentId: row.id,
          expression: config.expression,
          timezone: config.timezone,
          lastRanAt: row.cron_last_ran_at ? new Date(row.cron_last_ran_at) : null,
          nextRunAt,
        });
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        console.error(`${LOG_PREFIX} Invalid cron expression for ${row.system_slug}: ${msg}`);
      }
    }

    // Start polling timer
    pollTimer = setInterval(() => {
      pollAndExecute().catch((err) => {
        console.error(`${LOG_PREFIX} Poll cycle error:`, err);
      });
    }, POLL_INTERVAL_MS);

    console.log(`${LOG_PREFIX} Initialized with ${scheduleMap.size} scheduled systems`);
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to initialize:`, err);
  }
}

/**
 * Refresh a single system's schedule entry from the database.
 * Called when a system's cron config is updated via API.
 */
export async function refreshSchedule(slug: string): Promise<void> {
  const { rows } = await pool.query<CronDeploymentRow>(
    `SELECT id, system_slug, trigger_config, cron_last_ran_at, cron_next_run_at
     FROM deployments
     WHERE system_slug = $1
       AND status = 'deployed'
       AND trigger_type = 'cron'
       AND (trigger_config->>'enabled')::boolean = true`,
    [slug]
  );

  if (rows.length === 0) {
    // System no longer cron-enabled or not deployed — remove from schedule
    scheduleMap.delete(slug);
    console.log(`${LOG_PREFIX} Removed ${slug} from schedule`);
    return;
  }

  const row = rows[0];
  const config = row.trigger_config as CronTriggerConfig;

  const nextRunAt = computeNextRun(
    config.expression,
    config.timezone,
    row.cron_last_ran_at ? new Date(row.cron_last_ran_at) : null
  );

  scheduleMap.set(slug, {
    slug: row.system_slug,
    deploymentId: row.id,
    expression: config.expression,
    timezone: config.timezone,
    lastRanAt: row.cron_last_ran_at ? new Date(row.cron_last_ran_at) : null,
    nextRunAt,
  });

  console.log(`${LOG_PREFIX} Refreshed ${slug} (next: ${nextRunAt.toISOString()})`);
}

/**
 * Remove a system from the in-memory schedule.
 */
export function removeSchedule(slug: string): void {
  scheduleMap.delete(slug);
  console.log(`${LOG_PREFIX} Removed ${slug} from schedule`);
}

/**
 * Return current schedule state for monitoring.
 */
export function getScheduleStatus(): ScheduleStatusEntry[] {
  const entries: ScheduleStatusEntry[] = [];
  for (const [, schedule] of scheduleMap) {
    entries.push({
      slug: schedule.slug,
      expression: schedule.expression,
      timezone: schedule.timezone,
      lastRanAt: schedule.lastRanAt?.toISOString() ?? null,
      nextRunAt: schedule.nextRunAt.toISOString(),
      enabled: true,
    });
  }
  return entries;
}

/**
 * Stop the polling timer and clear in-memory state.
 */
export function destroyCronScheduler(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  scheduleMap.clear();
  console.log(`${LOG_PREFIX} Destroyed`);
}

// -----------------------------------------------------------------------------
// Polling logic
// -----------------------------------------------------------------------------

async function pollAndExecute(): Promise<void> {
  const now = new Date();

  for (const [slug, schedule] of scheduleMap) {
    if (now < schedule.nextRunAt) continue;

    try {
      // Re-fetch deployment to verify it's still deployed and cron-enabled
      const { rows } = await pool.query<DeploymentRow>(
        `SELECT * FROM deployments
         WHERE system_slug = $1
           AND status = 'deployed'
           AND trigger_type = 'cron'
           AND (trigger_config->>'enabled')::boolean = true`,
        [slug]
      );

      if (rows.length === 0) {
        // System is no longer eligible — remove from schedule
        scheduleMap.delete(slug);
        console.log(`${LOG_PREFIX} ${slug} no longer eligible — removed`);
        continue;
      }

      const row = rows[0];
      const canvas = row.canvas_json as { nodes?: unknown[]; edges?: unknown[] };

      if (!canvas?.nodes || !canvas?.edges) {
        console.error(`${LOG_PREFIX} ${slug} has invalid canvas state — skipping`);
        continue;
      }

      // Create execution_logs entry
      const { rows: logRows } = await pool.query<{ id: string }>(
        `INSERT INTO execution_logs (
           deployment_id, triggered_by, trigger_input, status, started_at
         ) VALUES ($1, $2, $3::jsonb, $4, now())
         RETURNING id`,
        [row.id, 'cron', JSON.stringify({ expression: schedule.expression }), 'running']
      );
      const executionId = logRows[0].id;

      // Build DeploymentRecord for trigger-executor
      const system: DeploymentRecord = {
        id: row.id,
        systemName: row.system_name,
        systemSlug: row.system_slug,
        manifestJson: row.manifest_json as DeploymentRecord['manifestJson'],
        canvasJson: row.canvas_json,
        openclawConfig: row.openclaw_config,
        triggerType: row.trigger_type as TriggerPattern,
        triggerConfig: row.trigger_config,
        pm2ProcessName: row.pm2_process_name,
        secretsDecrypted: null, // Cron executions don't need decrypted secrets in-flight
        status: row.status as DeploymentRecord['status'],
        domain: (row.domain as string | null) ?? null,
        tags: (row.tags as string[] | null) ?? [],
        deployedAt: row.deployed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };

      // Cron executions bypass per-user locks — they are system-initiated and
      // should never be blocked by (or block) user-triggered messaging executions.
      // Fire-and-forget execution (same pattern as POST /api/systems/:slug/trigger)
      runTriggerExecution(
        executionId,
        system,
        canvas as { nodes: unknown[]; edges: unknown[] },
        `Scheduled cron execution: ${system.systemName}`,
        undefined,
        undefined
      );

      // Update tracking columns and in-memory state
      const config = row.trigger_config as CronTriggerConfig;
      const nextRunAt = computeNextRun(config.expression, config.timezone, now);

      schedule.lastRanAt = now;
      schedule.nextRunAt = nextRunAt;

      await pool.query(
        `UPDATE deployments
         SET cron_last_ran_at = $1, cron_next_run_at = $2
         WHERE id = $3`,
        [now.toISOString(), nextRunAt.toISOString(), row.id]
      );

      console.log(`${LOG_PREFIX} Triggered ${slug} (next: ${nextRunAt.toISOString()})`);
    } catch (err) {
      // One system failing must not block others
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} Failed to execute ${slug}: ${msg}`);
    }
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Compute the next run time from a cron expression.
 * If lastRanAt is provided and in the past, compute next occurrence after now.
 * If lastRanAt is null (never ran), compute the next occurrence from now.
 */
function computeNextRun(
  expression: string,
  timezone: string,
  _lastRanAt: Date | null
): Date {
  const interval = CronExpressionParser.parse(expression, {
    currentDate: new Date(),
    tz: timezone,
  });
  return interval.next().toDate();
}

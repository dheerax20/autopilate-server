// =============================================================================
// System Monitor Service
// Operator agent: runs on a 5-minute cron. Detects unhealthy AUTOPILATE
// processes, diagnoses root causes via LLM, applies fixes, and logs actions.
// =============================================================================

import type Anthropic from '@anthropic-ai/sdk';
import { pool } from '../db';
import { smartGenerate } from '../lib/anthropic-client';
import {
  listProcesses,
  restartProcess,
  ProcessStatus,
} from './pm2-manager';
import { getSystem } from './registry';
import { DeploymentRecord } from '../types/registry';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type Diagnosis =
  | { kind: 'expired_key'; detail: string }
  | { kind: 'rate_limit'; detail: string }
  | { kind: 'malformed_config'; detail: string }
  | { kind: 'dependency_failure'; detail: string }
  | { kind: 'timeout'; detail: string }
  | { kind: 'oom'; detail: string }
  | { kind: 'unknown'; detail: string };

export interface OperatorAction {
  id: string;
  deploymentId: string;
  systemSlug: string;
  actionType: string;
  description: string;
  diagnosis: Diagnosis;
  autoApplied: boolean;
}

interface ErrorLogRow {
  error_message: string;
  completed_at: string;
}

interface OperatorActionRow {
  id: string;
}

interface FixResult {
  actionType: string;
  description: string;
  autoApplied: boolean;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const MAX_RESTART_THRESHOLD = 10;
const STALL_UPTIME_MS = 30_000;
const VALID_KINDS = new Set<Diagnosis['kind']>([
  'expired_key', 'rate_limit', 'malformed_config',
  'dependency_failure', 'timeout', 'oom', 'unknown',
]);

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Run a full health check across all deployed AUTOPILATE systems.
 * Returns all operator actions taken during this run.
 */
export async function runSystemMonitor(): Promise<OperatorAction[]> {
  console.log('[system-monitor] Starting health check...');
  const actions: OperatorAction[] = [];

  const processes = await listProcesses();
  const unhealthy = detectUnhealthy(processes);

  if (unhealthy.length === 0) {
    console.log('[system-monitor] All systems healthy.');
    return actions;
  }

  console.log(`[system-monitor] Found ${unhealthy.length} unhealthy process(es).`);

  for (const proc of unhealthy) {
    try {
      const action = await handleUnhealthyProcess(proc);
      if (action) actions.push(action);
    } catch (err) {
      console.error(
        `[system-monitor] Failed to handle ${proc.name}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  console.log(`[system-monitor] Completed. ${actions.length} action(s) taken.`);
  return actions;
}

/**
 * Register the system monitor to run every 5 minutes.
 * Returns a handle with a stop() method to cancel the cron.
 */
export function registerMonitorCron(): { stop: () => void } {
  console.log('[system-monitor] Registered cron (every 5 min)');

  runSystemMonitor().catch((err) => {
    console.error('[system-monitor] Initial run failed:', err);
  });

  const timer = setInterval(() => {
    runSystemMonitor().catch((err) => {
      console.error('[system-monitor] Scheduled run failed:', err);
    });
  }, MONITOR_INTERVAL_MS);

  return {
    stop: () => {
      clearInterval(timer);
      console.log('[system-monitor] Cron stopped.');
    },
  };
}

// -----------------------------------------------------------------------------
// Detection
// -----------------------------------------------------------------------------

function detectUnhealthy(processes: ProcessStatus[]): ProcessStatus[] {
  return processes.filter((proc) => {
    if (proc.status === 'errored' || proc.status === 'stopped') return true;
    if (proc.restarts >= MAX_RESTART_THRESHOLD) return true;
    // Crash-looping: several restarts with very low uptime
    if (proc.restarts > 3 && proc.uptime !== undefined) {
      const uptimeMs = Date.now() - proc.uptime;
      if (uptimeMs < STALL_UPTIME_MS) return true;
    }
    return false;
  });
}

function extractSlug(processName: string): string {
  return processName.replace(/^autopilate-/, '');
}

// -----------------------------------------------------------------------------
// Core: handle a single unhealthy process
// -----------------------------------------------------------------------------

async function handleUnhealthyProcess(
  proc: ProcessStatus
): Promise<OperatorAction | null> {
  const slug = extractSlug(proc.name);
  const deployment = await getSystem(slug);
  if (!deployment) {
    console.warn(`[system-monitor] No deployment record for slug: ${slug}`);
    return null;
  }

  const errors = await fetchRecentErrors(deployment.id);
  const errorContext = errors.map((e) => e.error_message).join('\n---\n');

  const diagnosis = await diagnoseWithLlm(proc, errorContext);
  const fix = await applyFix(diagnosis, deployment);

  try {
    await restartProcess(proc.name);
  } catch (err) {
    console.error(
      `[system-monitor] Restart failed for ${proc.name}:`,
      err instanceof Error ? err.message : String(err)
    );
  }

  return logOperatorAction(deployment, fix, diagnosis, proc);
}

// -----------------------------------------------------------------------------
// Database: fetch recent execution errors
// -----------------------------------------------------------------------------

async function fetchRecentErrors(deploymentId: string): Promise<ErrorLogRow[]> {
  const { rows } = await pool.query<ErrorLogRow>(
    `SELECT error_message, completed_at
     FROM execution_logs
     WHERE deployment_id = $1
       AND status = 'failed'
       AND completed_at > now() - $2::interval
     ORDER BY completed_at DESC
     LIMIT 20`,
    [deploymentId, '1 hour']
  );
  return rows;
}

// -----------------------------------------------------------------------------
// LLM Diagnosis (isolated for test mocking)
// -----------------------------------------------------------------------------

/**
 * Analyze process health data and error logs to diagnose the root cause.
 * Exported for test mocking — call smartGenerate internally.
 */
export async function diagnoseWithLlm(
  proc: ProcessStatus,
  errorContext: string
): Promise<Diagnosis> {
  const systemPrompt = [
    'You are a system operations expert. Analyze process health data and error logs to diagnose the root cause.',
    'Respond with ONLY a JSON object: {"kind": "<kind>", "detail": "<explanation>"}',
    'Valid kinds: expired_key, rate_limit, malformed_config, dependency_failure, timeout, oom, unknown',
  ].join('\n');

  const userMessage = [
    `Process: ${proc.name}`,
    `Status: ${proc.status}`,
    `Restarts: ${proc.restarts}`,
    `Memory: ${Math.round(proc.memory / 1024 / 1024)}MB`,
    `CPU: ${proc.cpu}%`,
    '',
    'Recent error logs:',
    errorContext || '(no recent errors)',
  ].join('\n');

  const response = await smartGenerate('BUILDER', systemPrompt, [
    { role: 'user', content: userMessage },
  ]);

  return parseDiagnosisResponse(response);
}

function parseDiagnosisResponse(response: Anthropic.Message): Diagnosis {
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === 'object' && parsed !== null &&
      'kind' in parsed && 'detail' in parsed
    ) {
      const obj = parsed as Record<string, unknown>;
      if (
        typeof obj.kind === 'string' &&
        typeof obj.detail === 'string' &&
        VALID_KINDS.has(obj.kind as Diagnosis['kind'])
      ) {
        return parsed as Diagnosis;
      }
    }
  } catch {
    // Fall through to unknown
  }

  return { kind: 'unknown', detail: text.slice(0, 500) };
}

// -----------------------------------------------------------------------------
// Fix Application
// -----------------------------------------------------------------------------

async function applyFix(
  diagnosis: Diagnosis,
  deployment: DeploymentRecord
): Promise<FixResult> {
  switch (diagnosis.kind) {
    case 'expired_key': return applyExpiredKeyFix();
    case 'rate_limit': return applyRateLimitFix(deployment);
    case 'timeout': return applyTimeoutFix(deployment);
    case 'oom': return applyOomFix(deployment);
    case 'malformed_config':
      return { actionType: 'flag_config_error', description: `Malformed config: ${diagnosis.detail}`, autoApplied: false };
    case 'dependency_failure':
      return { actionType: 'flag_dependency', description: `Dependency failure: ${diagnosis.detail}`, autoApplied: false };
    case 'unknown':
      return { actionType: 'flag_unknown', description: `Unknown issue: ${diagnosis.detail}. Process restarted.`, autoApplied: false };
  }
}

function applyExpiredKeyFix(): FixResult {
  const hasBackup = !!process.env.BUILDER_KEY_BACKUP || !!process.env.ARCHITECT_KEY_BACKUP;
  if (hasBackup) {
    return {
      actionType: 'key_rotation_available',
      description: 'Expired API key detected. Backup keys present — failover chain active.',
      autoApplied: true,
    };
  }
  return {
    actionType: 'key_rotation_needed',
    description: 'Expired API key detected. No backup keys configured. Manual rotation required.',
    autoApplied: false,
  };
}

async function applyRateLimitFix(deployment: DeploymentRecord): Promise<FixResult> {
  const config = (deployment.openclawConfig as Record<string, unknown>) ?? {};
  const updated = { ...config, fallbackModel: 'claude-3-7-sonnet-20250219', rateLimitMitigation: true };
  await pool.query(
    `UPDATE deployments SET openclaw_config = $1::jsonb, updated_at = now() WHERE id = $2`,
    [JSON.stringify(updated), deployment.id]
  );
  return {
    actionType: 'add_fallback_model',
    description: `Rate limit hit. Added fallback model to failover chain for ${deployment.systemSlug}.`,
    autoApplied: true,
  };
}

async function applyTimeoutFix(deployment: DeploymentRecord): Promise<FixResult> {
  const config = (deployment.openclawConfig as Record<string, unknown>) ?? {};
  const current = (config.timeoutMs as number) ?? 120_000;
  const increased = Math.min(current * 2, 600_000);
  await pool.query(
    `UPDATE deployments SET openclaw_config = $1::jsonb, updated_at = now() WHERE id = $2`,
    [JSON.stringify({ ...config, timeoutMs: increased }), deployment.id]
  );
  return {
    actionType: 'increase_timeout',
    description: `Timeout increased from ${current}ms to ${increased}ms for ${deployment.systemSlug}.`,
    autoApplied: true,
  };
}

async function applyOomFix(deployment: DeploymentRecord): Promise<FixResult> {
  const config = (deployment.openclawConfig as Record<string, unknown>) ?? {};
  const currentLimit = (config.maxMemoryRestart as string) ?? '256M';
  const currentMb = parseMemoryLimit(currentLimit);
  const newMb = Math.min(currentMb * 2, 4096);
  const newLimit = `${newMb}M`;
  await pool.query(
    `UPDATE deployments SET openclaw_config = $1::jsonb, updated_at = now() WHERE id = $2`,
    [JSON.stringify({ ...config, maxMemoryRestart: newLimit }), deployment.id]
  );
  return {
    actionType: 'increase_memory',
    description: `Memory limit raised from ${currentLimit} to ${newLimit} for ${deployment.systemSlug}.`,
    autoApplied: true,
  };
}

function parseMemoryLimit(limit: string): number {
  const match = limit.match(/^(\d+)(M|G)$/i);
  if (!match) return 256;
  const value = parseInt(match[1], 10);
  return match[2].toUpperCase() === 'G' ? value * 1024 : value;
}

// -----------------------------------------------------------------------------
// Logging: persist action to operator_actions table
// -----------------------------------------------------------------------------

async function logOperatorAction(
  deployment: DeploymentRecord,
  fix: FixResult,
  diagnosis: Diagnosis,
  proc: ProcessStatus
): Promise<OperatorAction> {
  const beforeState = {
    status: proc.status,
    restarts: proc.restarts,
    memory: proc.memory,
    cpu: proc.cpu,
  };

  const { rows } = await pool.query<OperatorActionRow>(
    `INSERT INTO operator_actions (
       deployment_id, operator_type, action_type,
       description, before_state, after_state, auto_applied
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
     RETURNING id`,
    [
      deployment.id,
      'system_monitor',
      fix.actionType,
      fix.description,
      JSON.stringify(beforeState),
      JSON.stringify({ diagnosis }),
      fix.autoApplied,
    ]
  );

  return {
    id: rows[0].id,
    deploymentId: deployment.id,
    systemSlug: deployment.systemSlug,
    actionType: fix.actionType,
    description: fix.description,
    diagnosis,
    autoApplied: fix.autoApplied,
  };
}

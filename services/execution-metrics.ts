// =============================================================================
// Execution Metrics Service
// Records per-execution metrics and provides aggregation queries for dashboard
// analytics. Writes are fire-and-forget — metric failures never block execution.
// =============================================================================

import { pool } from '../db';

export interface MetricData {
  systemSlug: string;
  executionId: string;
  startedAt: string;
  completedAt?: string;
  durationSeconds?: number;
  status: 'running' | 'success' | 'failed' | 'timeout';
  phasesTotal: number;
  phasesCompleted: number;
  costUsd?: number;
  errorMessage?: string;
  triggeredBy?: string;
  triggeredChannel?: string;
}

export interface SystemStats {
  totalExecutions: number;
  successCount: number;
  failedCount: number;
  successRate: number;
  avgDurationSeconds: number;
  totalCostUsd: number;
  lastExecution: string | null;
}

export interface GlobalStats {
  totalExecutions: number;
  successRate: number;
  avgDurationSeconds: number;
  totalCostUsd: number;
  systemBreakdown: Array<{ slug: string; count: number; successRate: number }>;
}

/**
 * Insert or update an execution metric row. Uses ON CONFLICT on execution_id
 * for idempotent upserts (initial insert on start, update on completion).
 */
export async function recordMetric(data: MetricData): Promise<void> {
  await pool.query(
    `INSERT INTO execution_metrics (
       system_slug, execution_id, started_at, completed_at, duration_seconds,
       status, phases_total, phases_completed, cost_usd, error_message,
       triggered_by, triggered_channel
     ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (execution_id) DO UPDATE SET
       completed_at = EXCLUDED.completed_at,
       duration_seconds = EXCLUDED.duration_seconds,
       status = EXCLUDED.status,
       phases_total = EXCLUDED.phases_total,
       phases_completed = EXCLUDED.phases_completed,
       cost_usd = EXCLUDED.cost_usd,
       error_message = EXCLUDED.error_message`,
    [
      data.systemSlug,
      data.executionId,
      data.startedAt,
      data.completedAt ?? null,
      data.durationSeconds ?? null,
      data.status,
      data.phasesTotal,
      data.phasesCompleted,
      data.costUsd ?? 0,
      data.errorMessage ?? null,
      data.triggeredBy ?? null,
      data.triggeredChannel ?? null,
    ]
  );
}

/**
 * Aggregate stats for a single system within a time window.
 */
export async function getSystemStats(
  systemSlug: string,
  hours = 24
): Promise<SystemStats> {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total_executions,
       COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
       COALESCE(AVG(duration_seconds) FILTER (WHERE duration_seconds IS NOT NULL), 0) AS avg_duration,
       COALESCE(SUM(cost_usd), 0) AS total_cost,
       MAX(created_at) AS last_execution
     FROM execution_metrics
     WHERE system_slug = $1
       AND created_at > NOW() - make_interval(hours => $2)`,
    [systemSlug, hours]
  );

  const row = rows[0];
  const total = row.total_executions;

  return {
    totalExecutions: total,
    successCount: row.success_count,
    failedCount: row.failed_count,
    successRate: total > 0 ? row.success_count / total : 0,
    avgDurationSeconds: parseFloat(row.avg_duration) || 0,
    totalCostUsd: parseFloat(row.total_cost) || 0,
    lastExecution: row.last_execution ? row.last_execution.toISOString() : null,
  };
}

/**
 * Aggregate stats across all systems within a time window, including per-system breakdown.
 */
export async function getGlobalStats(hours = 24): Promise<GlobalStats> {
  const [globalResult, breakdownResult] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total_executions,
         COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
         COALESCE(AVG(duration_seconds) FILTER (WHERE duration_seconds IS NOT NULL), 0) AS avg_duration,
         COALESCE(SUM(cost_usd), 0) AS total_cost
       FROM execution_metrics
       WHERE created_at > NOW() - make_interval(hours => $1)`,
      [hours]
    ),
    pool.query(
      `SELECT
         system_slug,
         COUNT(*)::int AS count,
         COUNT(*) FILTER (WHERE status = 'success')::int AS success_count
       FROM execution_metrics
       WHERE created_at > NOW() - make_interval(hours => $1)
       GROUP BY system_slug
       ORDER BY count DESC`,
      [hours]
    ),
  ]);

  const g = globalResult.rows[0];
  const total = g.total_executions;

  return {
    totalExecutions: total,
    successRate: total > 0 ? g.success_count / total : 0,
    avgDurationSeconds: parseFloat(g.avg_duration) || 0,
    totalCostUsd: parseFloat(g.total_cost) || 0,
    systemBreakdown: breakdownResult.rows.map((r) => ({
      slug: r.system_slug,
      count: r.count,
      successRate: r.count > 0 ? r.success_count / r.count : 0,
    })),
  };
}

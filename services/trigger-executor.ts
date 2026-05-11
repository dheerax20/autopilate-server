// =============================================================================
// Trigger Executor Service
// Runs system executions asynchronously, updates execution_logs,
// notifies via Redis pub/sub on failure, and POSTs to callback URLs.
// =============================================================================

import { pool } from '../db';
import { executeWorkflow } from './orchestrator-bridge';
import { DeploymentRecord } from '../types/registry';
import { recordMetric } from './execution-metrics';
import { isCallbackUrlSafe } from '../lib/url-validator';

import { getRedisPublisher } from '../lib/redis';

const REDIS_CHANNEL_PREFIX = 'autopilate:logs:';

/**
 * Run a system execution asynchronously. Called fire-and-forget from the
 * trigger route after the 202 response has been sent.
 *
 * - Calls orchestrator-bridge executeWorkflow with the system's canvas state
 * - Streams progress via Socket.io (executeWorkflow does this using sessionId)
 * - On completion: updates execution_logs with status, duration, cost
 * - On failure: updates execution_logs with error, publishes to Redis
 * - If callbackUrl provided: POSTs result to that URL
 */
export async function runTriggerExecution(
  executionId: string,
  system: DeploymentRecord,
  canvas: { nodes: unknown[]; edges: unknown[] },
  brief: string | undefined,
  inputs: Record<string, unknown> | undefined,
  callbackUrl: string | undefined
): Promise<void> {
  const startTime = Date.now();

  try {
    const briefText = brief || `Execute system: ${system.systemName}`;
    const fullBrief = inputs
      ? `${briefText}\n\nInputs:\n${JSON.stringify(inputs, null, 2)}`
      : briefText;

    // executionId doubles as the Socket.io sessionId for streaming progress
    // Canvas data from DB is jsonb — cast through unknown to satisfy CanvasNode/CanvasEdge types
    const report = await executeWorkflow(
      executionId,
      canvas.nodes as unknown as Parameters<typeof executeWorkflow>[1],
      canvas.edges as unknown as Parameters<typeof executeWorkflow>[2],
      fullBrief,
      system.systemName,
      { executionLogId: executionId, deploymentId: system.id }
    );

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);

    await pool.query(
      `UPDATE execution_logs SET
         status = $1,
         phases_completed = $2,
         phases_total = $3,
         duration_seconds = $4,
         cost_usd = $5,
         completed_at = now()
       WHERE id = $6`,
      [
        report.status === 'failed' ? 'failed' : 'completed',
        report.phases.length,
        report.phases.length,
        durationSeconds,
        report.totalCost,
        executionId,
      ]
    );

    // Fire-and-forget metrics write — never blocks execution
    recordMetric({
      systemSlug: system.systemSlug,
      executionId,
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationSeconds,
      status: report.status === 'failed' ? 'failed' : 'success',
      phasesTotal: report.phases.length,
      phasesCompleted: report.phases.length,
      costUsd: report.totalCost,
      triggeredBy: 'trigger',
    }).catch((err) => {
      console.error('[trigger-executor] Metrics write failed:', err);
    });

    if (callbackUrl) {
      await postCallback(callbackUrl, {
        executionId,
        status: report.status,
        durationSeconds,
        costUsd: report.totalCost,
        totalTokens: report.totalTokens,
        phases: report.phases.length,
      });
    }
  } catch (err) {
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Update execution_logs with failure
    await pool.query(
      `UPDATE execution_logs SET
         status = $1,
         duration_seconds = $2,
         error_message = $3,
         completed_at = now()
       WHERE id = $4`,
      ['failed', durationSeconds, errorMessage, executionId]
    ).catch((dbErr) => {
      console.error('[trigger-executor] Failed to update execution_logs:', dbErr);
    });

    // Fire-and-forget metrics write for failure
    recordMetric({
      systemSlug: system.systemSlug,
      executionId,
      startedAt: new Date(startTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationSeconds,
      status: 'failed',
      phasesTotal: 0,
      phasesCompleted: 0,
      errorMessage: errorMessage,
      triggeredBy: 'trigger',
    }).catch((metricsErr) => {
      console.error('[trigger-executor] Metrics write failed:', metricsErr);
    });

    // Notify via Redis pub/sub
    try {
      const channel = `${REDIS_CHANNEL_PREFIX}${system.systemSlug}`;
      getRedisPublisher().publish(channel, JSON.stringify({
        event: 'execution:failed',
        executionId,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      }));
    } catch (redisErr) {
      console.error('[trigger-executor] Redis publish failed:', redisErr);
    }

    if (callbackUrl) {
      await postCallback(callbackUrl, {
        executionId,
        status: 'failed',
        durationSeconds,
        error: errorMessage,
      }).catch(() => {});
    }
  }
}

async function postCallback(
  url: string,
  payload: Record<string, unknown>
): Promise<void> {
  const validation = isCallbackUrlSafe(url);
  if (!validation.safe) {
    console.warn(`[trigger-executor] Callback URL blocked (SSRF protection): ${url} — ${validation.reason}`);
    return;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn(`[trigger-executor] Callback to ${url} returned ${response.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[trigger-executor] Callback to ${url} failed: ${msg}`);
  }
}

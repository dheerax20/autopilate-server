// =============================================================================
// Metrics Socket.io Emitter
// Subscribes to execution-events bus and forwards metrics to connected clients.
// Also handles on-demand metrics:request from individual sockets.
// =============================================================================

import { TypedSocket, TypedSocketServer, getSocketServer } from './emitter';
import {
  onAnyExecutionProgress,
  ExecutionProgressEvent,
} from '../services/execution-events';
import { getSystemStats, getGlobalStats } from '../services/execution-metrics';

let unsubscribe: (() => void) | null = null;

/**
 * Initialize the global metrics event forwarder.
 * Subscribes to the execution-events bus and broadcasts metrics to all
 * connected Socket.io clients whenever an execution completes or fails.
 */
export function initMetricsEmitter(): void {
  if (unsubscribe) return; // Already initialized

  unsubscribe = onAnyExecutionProgress((event: ExecutionProgressEvent) => {
    let io: TypedSocketServer;
    try {
      io = getSocketServer();
    } catch {
      return; // Socket server not ready
    }

    const slug = event.systemSlug ?? 'unknown';

    if (event.type === 'phase-start' && event.phaseIndex === 0) {
      // First phase starting = execution started
      io.emit('metrics:execution-started', {
        systemSlug: slug,
        executionId: event.executionId,
        startedAt: new Date().toISOString(),
      });
    } else if (event.type === 'complete') {
      io.emit('metrics:execution-completed', {
        systemSlug: slug,
        executionId: event.executionId,
        duration: event.durationSeconds ?? 0,
        cost: event.costUsd ?? 0,
        status: event.status === 'partial' ? 'partial' : 'success',
      });
    } else if (event.type === 'failed') {
      io.emit('metrics:execution-failed', {
        systemSlug: slug,
        executionId: event.executionId,
        error: event.errorMessage ?? 'Unknown error',
      });
    }
  });

  console.log('[MetricsEmitter] Subscribed to execution event bus');
}

/**
 * Set up per-connection metrics handlers (metrics:request).
 * Call this inside the io.on('connection') handler for each new socket.
 */
export function setupMetricsSocketHandlers(socket: TypedSocket): void {
  socket.on('metrics:request', async (payload) => {
    try {
      const hours = payload.hours ?? 24;

      if (payload.slug) {
        const stats = await getSystemStats(payload.slug, hours);
        socket.emit('metrics:response', {
          type: 'system',
          slug: payload.slug,
          stats,
        });
      } else {
        const stats = await getGlobalStats(hours);
        socket.emit('metrics:response', {
          type: 'global',
          stats,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch metrics';
      console.error('[MetricsEmitter] metrics:request error:', message);
      socket.emit('error', {
        code: 'METRICS_ERROR',
        message,
      });
    }
  });
}

/**
 * Tear down the global subscription (for graceful shutdown).
 */
export function destroyMetricsEmitter(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

// =============================================================================
// Execution Progress Event Bus
// In-process EventEmitter for forwarding execution phase progress to consumers
// like the OpenClaw message bridge without coupling to Socket.io.
// =============================================================================

import { EventEmitter } from 'node:events';

export interface ExecutionProgressEvent {
  executionId: string;
  type:
    | 'phase-start'
    | 'phase-complete'
    | 'complete'
    | 'failed'
    | 'agent-started'
    | 'agent-completed'
    | 'heartbeat';
  phaseIndex?: number;
  totalPhases?: number;
  phaseName?: string;
  agentName?: string;
  status?: string;
  systemSlug?: string;
  durationSeconds?: number;
  elapsedSeconds?: number;
  costUsd?: number;
  errorMessage?: string;
}

const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emitExecutionProgress(event: ExecutionProgressEvent): void {
  bus.emit(`exec:${event.executionId}`, event);
  // Global channel for cross-cutting concerns like metrics
  bus.emit('exec:all', event);
}

/**
 * Subscribe to progress events for a specific execution.
 * Returns an unsubscribe function.
 */
export function onExecutionProgress(
  executionId: string,
  handler: (event: ExecutionProgressEvent) => void
): () => void {
  const key = `exec:${executionId}`;
  bus.on(key, handler);
  return () => {
    bus.removeListener(key, handler);
  };
}

/**
 * Subscribe to ALL execution progress events across every execution.
 * Used by metrics-emitter and other cross-cutting concerns.
 * Returns an unsubscribe function.
 */
export function onAnyExecutionProgress(
  handler: (event: ExecutionProgressEvent) => void
): () => void {
  bus.on('exec:all', handler);
  return () => {
    bus.removeListener('exec:all', handler);
  };
}

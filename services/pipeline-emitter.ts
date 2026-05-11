// =============================================================================
// PipelineEmitter — abstract surface for orchestrator pipeline events
//
// The orchestrator-bridge used to emit directly to Socket.io for every log,
// step, agent result, and final report. That coupled the entire execution
// engine to the VAB frontend — a CLI run, a cron job, or a messaging
// supervisor couldn't reuse the engine because nothing implements the
// Socket.io server contract outside the VAB.
//
// PipelineEmitter is the thin boundary. OrchestratorCore depends on this
// interface; callers (VAB / CLI / supervisors / tests) pick the adapter.
// =============================================================================

import type {
  ExecutionStepPayload,
  ExecutionStepResultPayload,
  AgentResultPayload,
  ExecutionReportPayload,
} from '../shared/socket-events';

export interface PipelineEmitter {
  /** Human-readable log line. `stream` defaults to 'stdout'. */
  log(
    sessionId: string,
    message: string,
    stream?: 'stdout' | 'stderr',
    source?: 'workflow' | 'fixer'
  ): void;

  /** Structured phase-start event. */
  stepStart(payload: ExecutionStepPayload): void;

  /** Structured phase-complete event. */
  stepComplete(payload: ExecutionStepResultPayload): void;

  /** Per-agent structured result. */
  agentResult(payload: AgentResultPayload): void;

  /** Final execution report. */
  executionReport(payload: ExecutionReportPayload): void;
}

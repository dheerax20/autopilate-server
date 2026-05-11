// =============================================================================
// SocketEmitter — PipelineEmitter adapter that emits to Socket.io
// Pure pass-through to the existing wrappers in ../socket/emitter so the
// VAB frontend experience is byte-for-byte identical to the pre-migration
// direct-call behavior.
// =============================================================================

import {
  emitExecutionLog,
  emitExecutionStepStart,
  emitExecutionStepComplete,
  emitAgentResult,
  emitExecutionReport,
} from '../../socket/emitter';
import type {
  ExecutionStepPayload,
  ExecutionStepResultPayload,
  AgentResultPayload,
  ExecutionReportPayload,
} from '../../shared/socket-events';
import type { PipelineEmitter } from '../pipeline-emitter';

export class SocketEmitter implements PipelineEmitter {
  log(
    sessionId: string,
    message: string,
    stream: 'stdout' | 'stderr' = 'stdout',
    source?: 'workflow' | 'fixer'
  ): void {
    emitExecutionLog(sessionId, message, stream, source);
  }

  stepStart(payload: ExecutionStepPayload): void {
    emitExecutionStepStart(payload);
  }

  stepComplete(payload: ExecutionStepResultPayload): void {
    emitExecutionStepComplete(payload);
  }

  agentResult(payload: AgentResultPayload): void {
    emitAgentResult(payload);
  }

  executionReport(payload: ExecutionReportPayload): void {
    emitExecutionReport(payload);
  }
}

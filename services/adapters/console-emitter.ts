// =============================================================================
// ConsoleEmitter — PipelineEmitter adapter for headless/CLI execution
// Writes a structured representation of the pipeline to stdout/stderr so
// cli-runner.ts (and any other headless caller) can run OrchestratorCore
// with no Socket.io server or VAB frontend in sight.
// =============================================================================

import type {
  ExecutionStepPayload,
  ExecutionStepResultPayload,
  AgentResultPayload,
  ExecutionReportPayload,
} from '../../shared/socket-events';
import type { PipelineEmitter } from '../pipeline-emitter';

export class ConsoleEmitter implements PipelineEmitter {
  log(
    _sessionId: string,
    message: string,
    stream: 'stdout' | 'stderr' = 'stdout',
    _source?: 'workflow' | 'fixer'
  ): void {
    if (stream === 'stderr') {
      process.stderr.write(`${message}\n`);
    } else {
      process.stdout.write(`${message}\n`);
    }
  }

  stepStart(payload: ExecutionStepPayload): void {
    process.stdout.write(
      `\n▶ Phase ${payload.stepOrder}/${payload.totalSteps}: ${payload.stepName}\n`
    );
  }

  stepComplete(payload: ExecutionStepResultPayload): void {
    const mark = payload.success ? '✓' : '✗';
    process.stdout.write(
      `${mark} Phase ${payload.stepOrder}/${payload.totalSteps} ${payload.stepName} ${payload.success ? 'complete' : 'failed'}\n`
    );
  }

  agentResult(payload: AgentResultPayload): void {
    const status = payload.status.toUpperCase();
    process.stdout.write(
      `\n── ${payload.agentLabel} [${status}] ${payload.durationMs}ms $${payload.cost.toFixed(4)} ──\n`
    );
    process.stdout.write(`${payload.output}\n`);
  }

  executionReport(payload: ExecutionReportPayload): void {
    process.stdout.write('\n' + '═'.repeat(60) + '\n');
    process.stdout.write(`EXECUTION REPORT — ${payload.workflow}\n`);
    process.stdout.write(`Status:    ${payload.status}\n`);
    process.stdout.write(`Duration:  ${(payload.totalDurationMs / 1000).toFixed(1)}s\n`);
    process.stdout.write(`Cost:      $${payload.totalCost.toFixed(4)}\n`);
    process.stdout.write(
      `Tokens:    ${payload.totalTokens.input} in / ${payload.totalTokens.output} out\n`
    );
    process.stdout.write(`Phases:    ${payload.phases.length}\n`);
    process.stdout.write(
      `Agents:    ${payload.phases.reduce((n, p) => n + p.results.length, 0)}\n`
    );
    process.stdout.write('═'.repeat(60) + '\n');
  }
}

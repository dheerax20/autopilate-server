// =============================================================================
// OrchestratorCore — clean API surface for headless pipeline execution
//
// This is the entry point any non-VAB caller (cli-runner, future
// supervisors, cron triggers, messaging adapters) should use to run a
// canvas pipeline end-to-end. Internally it delegates to the parameterized
// executeWorkflow() in orchestrator-bridge, passing a user-supplied
// PipelineEmitter that decides where structured events go (Socket.io,
// stdout, file, Slack, etc.).
//
// We deliberately do NOT move the 270-line executeWorkflow body here on
// this first pass — doing so would produce a high-churn diff for zero
// runtime change. When a supervisor layer lands and needs OrchestratorCore
// as an importable class with its own state, the body can be lifted at
// that point without breaking the public surface this file exposes.
// =============================================================================

import { executeWorkflow, type ExecutionReport } from './orchestrator-bridge';
import type { PipelineEmitter } from './pipeline-emitter';

export interface RunPipelineArgs {
  sessionId: string;
  canvasNodes: unknown[];
  canvasEdges: unknown[];
  brief?: string;
  workflowName?: string;
  qaContext?: { executionLogId: string; deploymentId: string };
}

/**
 * Thin, emitter-owning facade around executeWorkflow. Construct once per
 * consumer with the emitter that matches the surface you're targeting
 * (SocketEmitter for the VAB terminal, ConsoleEmitter for a CLI, etc.).
 *
 * @example
 * const core = new OrchestratorCore(new ConsoleEmitter());
 * const report = await core.run({ sessionId, canvasNodes, canvasEdges, brief });
 */
export class OrchestratorCore {
  constructor(private emitter: PipelineEmitter) {}

  async run(args: RunPipelineArgs): Promise<ExecutionReport> {
    return executeWorkflow(
      args.sessionId,
      args.canvasNodes as Parameters<typeof executeWorkflow>[1],
      args.canvasEdges as Parameters<typeof executeWorkflow>[2],
      args.brief ?? 'Execute the workflow.',
      args.workflowName ?? 'Canvas Workflow',
      args.qaContext,
      this.emitter
    );
  }
}

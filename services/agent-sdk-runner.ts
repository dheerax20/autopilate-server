// =============================================================================
// Agent SDK Runner
// Executes a single workflow agent via @anthropic-ai/claude-agent-sdk query().
// Replaces the manual messages.stream() + tool-use loop in orchestrator-bridge.
// The SDK handles tool-use iteration, MCP server lifecycle, streaming, and
// cost/usage reporting natively — we just translate shapes in and out.
// =============================================================================

import { emitExecutionProgress } from './execution-events';
import type { WorkflowNode, AgentResult } from './orchestrator-bridge';

// The Agent SDK ships as ESM-only (`"type": "module"`) but server code is CJS.
// Static import would compile to require() and throw ERR_REQUIRE_ESM at runtime.
// Dynamic import() is preserved by TypeScript in CJS output, so it works.
let agentSdkPromise: Promise<typeof import('@anthropic-ai/claude-agent-sdk')> | null = null;
function loadAgentSdk() {
  if (!agentSdkPromise) {
    agentSdkPromise = import('@anthropic-ai/claude-agent-sdk');
  }
  return agentSdkPromise;
}

// Structural match with BridgeLogger in orchestrator-bridge — avoids
// a cross-file type import and keeps this module self-contained.
interface AgentSdkLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

/** A single MCP server the agent can talk to, stdio-spawned per query. */
export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RunAgentSdkArgs {
  agent: WorkflowNode;
  input: string;
  context: Record<string, unknown>;
  sessionId: string;
  logger: AgentSdkLogger;
  abortSignal?: AbortSignal;
  heartbeatMeta?: { phaseIndex: number; totalPhases: number };
  mcpConfigs: McpServerSpec[];
  /**
   * Absolute path to the per-execution workspace directory. When present,
   * a workspace-aware preamble is injected into the system prompt so the
   * agent knows to read prior artifacts and write its own outputs via
   * the filesystem MCP tools.
   */
  workspaceRoot?: string;
}

export async function runAgentViaSDK(args: RunAgentSdkArgs): Promise<AgentResult> {
  const { agent, input, context, sessionId, logger, abortSignal, heartbeatMeta, mcpConfigs, workspaceRoot } = args;

  const config = agent.config;
  const model = (config.model as string) || 'claude-sonnet-4-5-20250929';
  const baseSystemPrompt = (config.systemPrompt as string) || `You are ${agent.label}.`;
  // When we're running inside a scaffolded workspace, tell the agent up front
  // how to participate: use filesystem MCP tools to read prior-phase artifacts
  // and write its own outputs. Note the correct tool name is `read_text_file`,
  // not `read_file` — a rename landed in server-filesystem@2026.1.14.
  const systemPrompt = workspaceRoot
    ? `You have a filesystem workspace at ${workspaceRoot}. Read prior agents' artifacts with the filesystem MCP tool \`read_text_file\`, and write your own outputs with \`write_file\`. Artifacts are organized by team under strategy/, design/, development/, and qa/.\n\n${baseSystemPrompt}`
    : baseSystemPrompt;
  const timeoutMs =
    ((config.guardrails as Record<string, unknown>)?.timeoutSeconds as number || 120) * 1000;
  const maxTurns = (config.maxToolIterations as number) || 25;

  logger.info(
    { agent: agent.label, model, mcpServers: mcpConfigs.length, maxTurns },
    'Executing agent via Agent SDK'
  );
  const startTime = Date.now();

  // Heartbeat — same cadence as the legacy runAgent (every 15s) so the VAB
  // terminal keeps showing activity for long-running tool loops.
  const heartbeatInterval = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
    emitExecutionProgress({
      executionId: sessionId,
      type: 'heartbeat',
      agentName: agent.label,
      phaseIndex: heartbeatMeta?.phaseIndex,
      totalPhases: heartbeatMeta?.totalPhases,
      elapsedSeconds,
    });
  }, 15_000);

  // Combine external abort + local timeout into one AbortController the SDK
  // natively consumes via options.abortController.
  const abortController = new AbortController();
  const onExternalAbort = () => abortController.abort();
  abortSignal?.addEventListener('abort', onExternalAbort);
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    if (abortSignal?.aborted) {
      throw Object.assign(new Error('Execution cancelled'), { name: 'AbortError' });
    }

    const { query } = await loadAgentSdk();

    // Translate our array of MCP specs into the SDK's keyed record shape.
    const mcpServers: Record<string, { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }> = {};
    for (const mcp of mcpConfigs) {
      mcpServers[mcp.name] = {
        type: 'stdio',
        command: mcp.command,
        args: mcp.args ?? [],
        env: mcp.env,
      };
    }

    // Prompt shape matches the legacy runAgent exactly so agent behavior
    // parity is observable against baseline outputs.
    const hasContext = context && Object.keys(context).length > 0;
    const prompt = hasContext
      ? `## Context\n${JSON.stringify(context, null, 2)}\n\n## Task\n${input}`
      : input;

    const q = query({
      prompt,
      options: {
        model,
        systemPrompt, // string form fully replaces Claude Code's default preset
        mcpServers,
        tools: [],    // disable all built-in Claude Code tools — agents only get their MCP tools
        maxTurns,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        settingSources: [], // isolate from ~/.claude and project settings
        // Scope this agent's subprocess cwd to the workspace when one is
        // provided. The filesystem MCP (server-filesystem >= 2026.1.14)
        // uses the MCP roots protocol to overwrite its allowed dirs with
        // whatever the client advertises as root — which is the process
        // cwd. Without this, agents get access to the server/ tree
        // instead of the scaffolded workspace and artifacts leak.
        cwd: workspaceRoot ?? undefined,
        abortController,
        stderr: (data: string) => {
          // Route SDK subprocess stderr through the logger so MCP
          // connection failures surface via the same emitter as every
          // other agent log line (Socket.io in VAB, stdout in CLI).
          logger.warn({ agent: agent.label }, `[sdk-stderr] ${data.trim()}`);
        },
        strictMcpConfig: true,
      },
    });

    let output = '';
    let tokensUsed = { input: 0, output: 0 };
    let cost = 0;
    let numTurns = 0;
    let sawResult = false;
    let resultError: string | undefined;

    for await (const message of q) {
      if (message.type === 'result') {
        sawResult = true;
        if (message.subtype === 'success') {
          output = message.result;
          // NonNullableUsage is derived from BetaUsage — input_tokens/output_tokens
          // are the primary fields, cache fields are optional.
          const usage = message.usage as { input_tokens?: number; output_tokens?: number };
          tokensUsed = {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
          };
          cost = message.total_cost_usd ?? 0;
          numTurns = message.num_turns ?? 0;
        } else {
          // SDKResultError branch
          resultError = `SDK result subtype=${(message as { subtype?: string }).subtype ?? 'unknown'}`;
        }
      }
      // All other message types (assistant, system, stream_event, task_*, etc.)
      // are ignored here. The legacy runAgent didn't stream per-chunk text to
      // Socket.io either — it just collected the final output. Same semantics.
    }

    const durationMs = Date.now() - startTime;

    if (!sawResult) {
      // Stream ended without a result message — treat as error.
      throw new Error('Agent SDK stream ended without a result message');
    }

    if (resultError) {
      logger.error({ agent: agent.label, error: resultError }, 'Agent failed');
      return {
        agentId: agent.id,
        agentLabel: agent.label,
        status: 'error',
        output: resultError,
        tokensUsed,
        durationMs,
        cost,
      };
    }

    logger.info(
      {
        agent: agent.label,
        durationMs,
        tokens: `${tokensUsed.input}in/${tokensUsed.output}out`,
        cost: `$${cost.toFixed(4)}`,
        turns: numTurns,
      },
      'Agent completed'
    );

    return {
      agentId: agent.id,
      agentLabel: agent.label,
      status: 'success',
      output,
      tokensUsed,
      durationMs,
      cost,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    logger.error({ agent: agent.label, error: errorMessage }, 'Agent failed');

    return {
      agentId: agent.id,
      agentLabel: agent.label,
      status: (err as Error)?.name === 'AbortError' ? 'timeout' : 'error',
      output: errorMessage,
      tokensUsed: { input: 0, output: 0 },
      durationMs,
      cost: 0,
    };
  } finally {
    clearInterval(heartbeatInterval);
    clearTimeout(timeoutHandle);
    abortSignal?.removeEventListener('abort', onExternalAbort);
  }
}

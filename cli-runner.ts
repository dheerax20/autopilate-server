// =============================================================================
// cli-runner.ts — headless entry point for AUTOPILATE pipeline execution
//
// Runs a canvas JSON end-to-end with no Socket.io server, no React
// frontend, and no VAB terminal. The entire orchestrator, agent loop,
// MCP server lifecycle, phase sequencer, and final report path is
// exercised exactly as it is from the VAB — only the emission surface
// differs (stdout/stderr instead of Socket.io).
//
// Usage:
//   cd server && npx ts-node cli-runner.ts <canvas.json> [brief]
//   (ts-node is already a devDependency; tsx works too if installed)
//
// The canvas.json file may be either:
//   - A full canvas dump: { nodes: [...], edges: [...] }
//   - A React-Flow-style dump: { canvasNodes: [...], canvasEdges: [...] }
//
// Exit codes:
//   0 — execution completed with status 'success'
//   1 — execution completed with status 'partial' or 'failed'
//   2 — fatal error before execution could start
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import dotenv from 'dotenv';
import { OrchestratorCore } from './services/orchestrator-core';
import { ConsoleEmitter } from './services/adapters/console-emitter';

// Match server/src/index.ts — load server/.env into process.env so the
// Agent SDK subprocess inherits ANTHROPIC_API_KEY etc.
dotenv.config({ path: path.resolve(__dirname, '.env'), override: false });

async function main(): Promise<number> {
  const [, , canvasPathArg, briefArg] = process.argv;

  if (!canvasPathArg) {
    process.stderr.write(
      'Usage: cd server && npx ts-node cli-runner.ts <canvas.json> [brief]\n'
    );
    return 2;
  }

  const canvasPath = path.resolve(process.cwd(), canvasPathArg);
  if (!fs.existsSync(canvasPath)) {
    process.stderr.write(`[cli-runner] Canvas file not found: ${canvasPath}\n`);
    return 2;
  }

  let canvas: { nodes?: unknown[]; edges?: unknown[]; canvasNodes?: unknown[]; canvasEdges?: unknown[] };
  try {
    canvas = JSON.parse(fs.readFileSync(canvasPath, 'utf-8'));
  } catch (err) {
    process.stderr.write(
      `[cli-runner] Failed to parse canvas JSON: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }

  const nodes = canvas.nodes ?? canvas.canvasNodes ?? [];
  const edges = canvas.edges ?? canvas.canvasEdges ?? [];

  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    process.stderr.write(
      '[cli-runner] Canvas JSON must expose nodes/edges (or canvasNodes/canvasEdges) as arrays\n'
    );
    return 2;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write(
      '[cli-runner] ANTHROPIC_API_KEY is not set. The Agent SDK subprocess needs it.\n'
    );
    return 2;
  }

  const core = new OrchestratorCore(new ConsoleEmitter());
  const sessionId = crypto.randomUUID();
  const brief = briefArg ?? 'Execute the workflow.';
  const workflowName = path.basename(canvasPath, path.extname(canvasPath));

  process.stdout.write(`[cli-runner] sessionId=${sessionId}\n`);
  process.stdout.write(`[cli-runner] canvas=${canvasPath}\n`);
  process.stdout.write(`[cli-runner] brief=${brief}\n`);
  process.stdout.write(`[cli-runner] nodes=${nodes.length} edges=${edges.length}\n\n`);

  try {
    const report = await core.run({
      sessionId,
      canvasNodes: nodes,
      canvasEdges: edges,
      brief,
      workflowName,
    });
    return report.status === 'success' ? 0 : 1;
  } catch (err) {
    process.stderr.write(
      `[cli-runner] Fatal error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    if (err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(
      `[cli-runner] Unhandled: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(2);
  }
);

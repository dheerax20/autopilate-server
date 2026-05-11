// =============================================================================
// Workspace — per-execution filesystem scaffolding for inter-agent handoff
//
// Every pipeline run gets its own directory tree under
// <repo-root>/.autopilate-workspaces/<executionId>/. Agents that have the
// filesystem MCP mounted can read and write files in their scoped subdir,
// which is the mechanism that lets downstream agents pick up artifacts
// produced by upstream agents (e.g. Designer writes wireframes, Engineer
// reads them).
//
// The scoping is intentionally coarse: a handful of role buckets, mapped
// by agent label. Unknown labels fall back to full-workspace access so
// small / experimental canvases still work without needing to teach the
// map a new agent every time.
// =============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type { McpServerSpec } from './agent-sdk-runner';

// Deterministic path independent of where the process was launched from.
// __dirname in CJS compiled output resolves to server/services/, so
// ../../.autopilate-workspaces lands at <repo-root>/.autopilate-workspaces/.
const DEFAULT_WORKSPACE_ROOT = path.resolve(__dirname, '../../.autopilate-workspaces');
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_ROOT;

// Subdirectories scaffolded under every execution workspace.
const WORKSPACE_LAYOUT = [
  'strategy',
  'design/wireframes',
  'design/design-system',
  'development/src',
  'qa',
] as const;

// Role → accessible subdirectories map. Lowercased agent labels are looked
// up here; unknown labels get whole-workspace access (the pragmatic default).
const ROLE_ACCESS_MAP: Record<string, string[]> = {
  // Strategy team
  'market researcher': ['strategy'],
  'copywriter': ['strategy'],
  'strategy lead': ['strategy'],

  // Design team
  'ux/ui architect': ['strategy', 'design'],
  'ux architect': ['strategy', 'design'],
  'ui architect': ['strategy', 'design'],
  'visual designer': ['design'],
  'design lead': ['design'],

  // Development team
  'frontend engineer': ['design', 'development'],
  'perf & seo engineer': ['development'],
  'perf and seo engineer': ['development'],
  'dev lead': ['development'],

  // QA / orchestration
  'quality auditor': ['.'], // whole workspace
  'project director': ['.'], // whole workspace
};

/**
 * Create the per-execution workspace tree and drop in brief.md + state.json.
 * Idempotent: recreating an existing workspace is a no-op for the layout
 * and just overwrites brief.md / state.json (useful for resumed runs).
 */
export async function scaffoldWorkspace(
  executionId: string,
  brief: string
): Promise<string> {
  const root = path.join(WORKSPACE_ROOT, executionId);
  await fs.mkdir(root, { recursive: true });
  for (const dir of WORKSPACE_LAYOUT) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  await fs.writeFile(path.join(root, 'brief.md'), brief, 'utf-8');
  await fs.writeFile(
    path.join(root, 'state.json'),
    JSON.stringify(
      {
        executionId,
        status: 'TRIGGERED',
        startedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf-8'
  );
  return root;
}

/**
 * Recursively remove a workspace. Safe to call on a non-existent path
 * (rm with force: true swallows ENOENT).
 */
export async function cleanupWorkspace(executionId: string): Promise<void> {
  const root = path.join(WORKSPACE_ROOT, executionId);
  await fs.rm(root, { recursive: true, force: true });
}

/**
 * Produce the stdio MCP config that spawns @modelcontextprotocol/server-filesystem
 * scoped to this agent's allowed subdirectories of the given workspace.
 *
 * The returned spec can be appended to the per-agent mcpConfigs list so the
 * Agent SDK spawns it alongside any canvas-declared MCP servers.
 */
export function filesystemMcpConfig(
  agentLabel: string,
  workspaceRoot: string
): McpServerSpec {
  const key = agentLabel.toLowerCase().trim();
  const relDirs = ROLE_ACCESS_MAP[key] ?? ['.'];
  const absDirs = relDirs.map((d) =>
    d === '.' ? workspaceRoot : path.join(workspaceRoot, d)
  );
  // Slug the label the same way buildMcpConfigs does so the SDK record key
  // is valid: mcp__<slug>__<tool>.
  const slug = ('fs-' + agentLabel.replace(/[^a-zA-Z0-9_-]/g, '-')).toLowerCase();
  return {
    name: slug,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', ...absDirs],
  };
}

/**
 * Exposed for logging / debugging — where this process will scaffold
 * workspaces when scaffoldWorkspace() is called.
 */
export function getWorkspaceRoot(): string {
  return WORKSPACE_ROOT;
}

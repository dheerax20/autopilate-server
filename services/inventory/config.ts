// =============================================================================
// Inventory Configuration
// =============================================================================

import { RepoConfig, NestedMcpConfig } from './types';

// Configurable via INVENTORY_ROOT env var; falls back to hardcoded default
const DEFAULT_INVENTORY_ROOT = '/Users/reedrichardson/Desktop/Master-Agent';
export const INVENTORY_ROOT = process.env.INVENTORY_ROOT || DEFAULT_INVENTORY_ROOT;

/**
 * Get the inventory root path (configurable via INVENTORY_ROOT env var).
 */
export function getInventoryRoot(): string {
  return INVENTORY_ROOT;
}

// MCP configurations for nested structures within 1.MCP-MISC
export const NESTED_MCP_CONFIGS: NestedMcpConfig[] = [
  // Google Workspace MCP services (gcalendar, gdocs, gmail, etc.)
  { repoName: 'google_workspace_mcp-main', subPath: '', category: 'google-workspace', pattern: /^g[a-z]+$/ },
  // GCloud MCP packages
  { repoName: 'gcloud-mcp-main', subPath: 'packages', category: 'google-cloud' },
  // MCP Security servers
  { repoName: 'mcp-security-main', subPath: 'server', category: 'security' },
  // n8n integration nodes
  { repoName: 'n8n-master', subPath: 'packages/nodes-base/nodes', category: 'n8n-integrations' },
];

// Configuration for each repo and where to find components
export const REPO_CONFIGS: RepoConfig[] = [
  {
    name: 'claude-code-templates-main',
    componentPaths: [
      { type: 'agents', path: 'cli-tool/components/agents' },
      { type: 'commands', path: 'cli-tool/components/commands' },
      { type: 'skills', path: 'cli-tool/components/skills' },
      { type: 'hooks', path: 'cli-tool/components/hooks' },
      { type: 'mcps', path: 'cli-tool/components/mcps' },
      { type: 'settings', path: 'cli-tool/components/settings' },
    ]
  },
  {
    name: 'superpowers-main',
    componentPaths: [
      { type: 'agents', path: 'agents' },
      { type: 'commands', path: 'commands' },
      { type: 'skills', path: 'skills' },
      { type: 'hooks', path: 'hooks' },
    ]
  },
  {
    name: 'skills-main',
    componentPaths: [
      { type: 'skills', path: 'skills' },
    ]
  },
  {
    name: 'claude-code-main',
    componentPaths: [
      // Agents
      { type: 'agents', path: 'plugins/feature-dev/agents', categoryFromPath: true },
      { type: 'agents', path: 'plugins/plugin-dev/agents', categoryFromPath: true },
      { type: 'agents', path: 'plugins/pr-review-toolkit/agents', categoryFromPath: true },
      { type: 'agents', path: 'plugins/agent-sdk-dev/agents', categoryFromPath: true },
      { type: 'agents', path: 'plugins/hookify/agents', categoryFromPath: true },
      { type: 'agents', path: 'plugins/code-review/agents', categoryFromPath: true },
      { type: 'agents', path: 'plugins/frontend-design/agents', categoryFromPath: true },
      // Commands
      { type: 'commands', path: 'plugins/feature-dev/commands', categoryFromPath: true },
      { type: 'commands', path: 'plugins/plugin-dev/commands', categoryFromPath: true },
      { type: 'commands', path: 'plugins/pr-review-toolkit/commands', categoryFromPath: true },
      { type: 'commands', path: 'plugins/agent-sdk-dev/commands', categoryFromPath: true },
      { type: 'commands', path: 'plugins/hookify/commands', categoryFromPath: true },
      { type: 'commands', path: 'plugins/code-review/commands', categoryFromPath: true },
      { type: 'commands', path: 'plugins/ralph-wiggum/commands', categoryFromPath: true },
      { type: 'commands', path: 'plugins/commit-commands/commands', categoryFromPath: true },
      { type: 'commands', path: '.claude/commands' },
      // Skills
      { type: 'skills', path: 'plugins/plugin-dev/skills', categoryFromPath: true },
      { type: 'skills', path: 'plugins/hookify/skills', categoryFromPath: true },
      { type: 'skills', path: 'plugins/claude-opus-4-5-migration/skills', categoryFromPath: true },
      { type: 'skills', path: 'plugins/frontend-design/skills', categoryFromPath: true },
      // Hooks
      { type: 'hooks', path: 'plugins/hookify/hooks', categoryFromPath: true },
      { type: 'hooks', path: 'plugins/ralph-wiggum/hooks', categoryFromPath: true },
      { type: 'hooks', path: 'plugins/learning-output-style/hooks', categoryFromPath: true },
      { type: 'hooks', path: 'plugins/explanatory-output-style/hooks', categoryFromPath: true },
      { type: 'hooks', path: 'plugins/security-guidance/hooks', categoryFromPath: true },
    ]
  },
  {
    name: 'claude-cookbooks-main',
    componentPaths: [
      { type: 'agents', path: 'patterns/agents/prompts' },
      { type: 'agents', path: '.claude/agents' },
      { type: 'commands', path: '.claude/commands' },
      { type: 'skills', path: '.claude/skills' },
    ]
  },
  {
    name: 'everything-claude-code-main',
    componentPaths: [
      { type: 'agents', path: 'agents' },
      { type: 'commands', path: 'commands' },
      { type: 'skills', path: 'skills' },
      { type: 'hooks', path: 'hooks' },
    ]
  },
];

// Map component types to NodeTypes used in the visual builder
export const TYPE_TO_NODE_TYPE: Record<string, string> = {
  agents: 'AGENT',
  commands: 'COMMAND',
  skills: 'SKILL',
  settings: 'PROVIDER',
  hooks: 'HOOK',
  mcps: 'TOOL',
};

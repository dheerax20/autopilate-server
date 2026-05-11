// =============================================================================
// Discover Source Configs
//
// Authoritative GitHub repos that we federate into the Discover marketplace.
// Each source describes a repository + path that contains one
// subdirectory per item (MCP server, skill, etc.). The github-repo fetcher
// walks the directory, reads the README.md or SKILL.md from each subdir, and
// converts it into a DiscoverItem.
//
// We pivoted from federating skills.sh / skillsmp.com / buildwithclaude.com to
// federating directly from GitHub because:
//   - skills.sh is an SPA shell with data hidden behind a client-rendered API
//   - skillsmp.com is gated by Cloudflare's JS challenge (even with API key)
//   - buildwithclaude.com's robots.txt explicitly disallows AI bots
//   - The actual source-of-truth content for all of them lives on GitHub anyway
// =============================================================================

import type { DiscoverItemType, DiscoverCategory } from '../discover-catalog';

export interface DiscoverSource {
  /** Stable id used in synced item ids and source attribution. */
  id: string;
  /** Display name for sync logs and the UI. */
  name: string;
  /** GitHub owner (org or user). */
  owner: string;
  /** GitHub repo name. */
  repo: string;
  /** Path within the repo to enumerate (each subdir = one item). */
  path: string;
  /** Type assigned to every item from this source. */
  type: DiscoverItemType;
  /** Default category — fetcher's heuristic categorize() can override. */
  defaultCategory: DiscoverCategory;
  /** README filename to look for in each subdir. Tries each in order. */
  readmeFiles: string[];
  /**
   * Template for the install command. {name} is replaced with the subdir name.
   * Examples:
   *   - 'uvx mcp-server-{name}'
   *   - 'npx -y @modelcontextprotocol/server-{name}'
   *   - 'autopilate skill add {name}'
   */
  installTemplate: string;
  /** Optional config snippet template (also supports {name}). */
  configTemplate?: string;
  /** Author label shown on the card. */
  author: string;
  /** Tags applied to every item from this source (in addition to per-item tags). */
  baseTags: string[];
}

export const DISCOVER_SOURCES: DiscoverSource[] = [
  {
    id: 'mcp-official-python',
    name: 'Official MCP Servers (Python)',
    owner: 'modelcontextprotocol',
    repo: 'servers',
    path: 'src',
    type: 'mcp',
    defaultCategory: 'developer-tools',
    readmeFiles: ['README.md', 'readme.md'],
    installTemplate: 'uvx mcp-server-{name}',
    configTemplate: `{
  "command": "uvx",
  "args": ["mcp-server-{name}"]
}`,
    author: 'Anthropic',
    baseTags: ['mcp', 'official', 'modelcontextprotocol'],
  },
  {
    id: 'anthropic-skills',
    name: 'Anthropic Agent Skills',
    owner: 'anthropics',
    repo: 'skills',
    path: 'skills',
    type: 'skill',
    defaultCategory: 'other',
    readmeFiles: ['SKILL.md', 'skill.md', 'README.md'],
    installTemplate: 'Add to your agent: clone https://github.com/anthropics/skills/tree/main/skills/{name}',
    author: 'Anthropic',
    baseTags: ['skill', 'official', 'anthropics'],
  },
  {
    id: 'vercel-agent-skills',
    name: 'Vercel Agent Skills',
    owner: 'vercel-labs',
    repo: 'agent-skills',
    path: 'skills',
    type: 'skill',
    defaultCategory: 'developer-tools',
    readmeFiles: ['SKILL.md', 'README.md'],
    installTemplate: 'Add to your agent: clone https://github.com/vercel-labs/agent-skills/tree/main/skills/{name}',
    author: 'Vercel',
    baseTags: ['skill', 'vercel', 'community'],
  },
  {
    id: 'microsoft-azure-skills',
    name: 'Microsoft Azure Skills',
    owner: 'microsoft',
    repo: 'azure-skills',
    path: 'skills',
    type: 'skill',
    defaultCategory: 'developer-tools',
    readmeFiles: ['SKILL.md', 'README.md'],
    installTemplate: 'Add to your agent: clone https://github.com/microsoft/azure-skills/tree/main/skills/{name}',
    author: 'Microsoft',
    baseTags: ['skill', 'azure', 'microsoft', 'community'],
  },
  // microsoft/skills uses a 2-level layout (skills/<language>/<name>/SKILL.md)
  // that our 1-level fetcher can't traverse — skipped until we add nested
  // directory support.
  //
  // openai/skills uses skills/.curated/ and skills/.system/ namespaces — same
  // 2-level issue, skipped for the same reason.
  {
    id: 'huggingface-skills',
    name: 'Hugging Face Skills',
    owner: 'huggingface',
    repo: 'skills',
    path: 'skills',
    type: 'skill',
    defaultCategory: 'ai-models',
    readmeFiles: ['SKILL.md', 'README.md'],
    installTemplate: 'Add to your agent: clone https://github.com/huggingface/skills/tree/main/skills/{name}',
    author: 'Hugging Face',
    baseTags: ['skill', 'huggingface', 'ml', 'community'],
  },
  {
    id: 'antfu-skills',
    name: 'Anthony Fu Skills',
    owner: 'antfu',
    repo: 'skills',
    path: 'skills',
    type: 'skill',
    defaultCategory: 'developer-tools',
    readmeFiles: ['SKILL.md', 'README.md'],
    installTemplate: 'Add to your agent: clone https://github.com/antfu/skills/tree/main/skills/{name}',
    author: 'Anthony Fu',
    baseTags: ['skill', 'community', 'frontend'],
  },
  {
    id: 'mcollina-skills',
    name: 'Matteo Collina Node.js Skills',
    owner: 'mcollina',
    repo: 'skills',
    path: 'skills',
    type: 'skill',
    defaultCategory: 'developer-tools',
    readmeFiles: ['SKILL.md', 'README.md'],
    installTemplate: 'Add to your agent: clone https://github.com/mcollina/skills/tree/main/skills/{name}',
    author: 'Matteo Collina',
    baseTags: ['skill', 'nodejs', 'community'],
  },
  {
    id: 'remotion-skills',
    name: 'Remotion Skills',
    owner: 'remotion-dev',
    repo: 'skills',
    path: 'skills',
    type: 'skill',
    defaultCategory: 'content',
    readmeFiles: ['SKILL.md', 'README.md'],
    installTemplate: 'Add to your agent: clone https://github.com/remotion-dev/skills/tree/main/skills/{name}',
    author: 'Remotion',
    baseTags: ['skill', 'video', 'community'],
  },
  {
    id: 'cloudflare-skills',
    name: 'Cloudflare Skills',
    owner: 'cloudflare',
    repo: 'skills',
    path: 'skills',
    type: 'skill',
    defaultCategory: 'developer-tools',
    readmeFiles: ['SKILL.md', 'README.md'],
    installTemplate: 'Add to your agent: clone https://github.com/cloudflare/skills/tree/main/skills/{name}',
    author: 'Cloudflare',
    baseTags: ['skill', 'cloudflare', 'edge', 'community'],
  },
  {
    id: 'browserbase-skills',
    name: 'Browserbase Skills',
    owner: 'browserbase',
    repo: 'skills',
    path: 'skills',
    type: 'skill',
    defaultCategory: 'scraping',
    readmeFiles: ['SKILL.md', 'README.md'],
    installTemplate: 'Add to your agent: clone https://github.com/browserbase/skills/tree/main/skills/{name}',
    author: 'Browserbase',
    baseTags: ['skill', 'browser', 'automation', 'community'],
  },
  {
    id: 'posthog-skills',
    name: 'PostHog Skills',
    owner: 'posthog',
    repo: 'skills',
    path: 'skills',
    type: 'skill',
    defaultCategory: 'data',
    readmeFiles: ['SKILL.md', 'README.md'],
    installTemplate: 'Add to your agent: clone https://github.com/posthog/skills/tree/main/skills/{name}',
    author: 'PostHog',
    baseTags: ['skill', 'analytics', 'posthog', 'community'],
  },
];

// =============================================================================
// Discover Catalog
//
// Hand-curated marketplace of community building blocks — MCP servers,
// Claude skills, and prompt templates — that users can browse, copy install
// commands from, and reference when building systems.
//
// Same shape as credential-catalog.ts: a static TypeScript constant that
// the catalog REST endpoint reads, merged with AI-generated entries from
// custom_discover_items via discover-registry.
//
// To add an entry: append to DISCOVER_CATALOG. Keep installCommand copy-paste
// runnable — most users will paste it straight into a terminal or canvas
// MCP node.
// =============================================================================

export type DiscoverItemType =
  | 'mcp'        // MCP server (stdio/SSE process that exposes tools)
  | 'skill'      // Claude skill (SKILL.md markdown with procedural knowledge)
  | 'prompt'     // Reusable system prompt or instruction template
  | 'agent'      // Full agent definition (persona, goals, tool wiring)
  | 'subagent'   // Nested agent spawned by a parent (.claude/agents/)
  | 'command'    // Slash command (.claude/commands/)
  | 'hook'       // Lifecycle hook (.claude/hooks/)
  | 'plugin';    // Claude plugin bundle (.claude-plugin/)

export type DiscoverCategory =
  | 'web-search'
  | 'scraping'
  | 'data'
  | 'storage'
  | 'communication'
  | 'productivity'
  | 'ai-models'
  | 'developer-tools'
  | 'research'
  | 'content'
  | 'reasoning'
  | 'other';

/**
 * Where an item came from — drives the trust badge in the UI.
 *
 *   curated      — hand-picked entry in DISCOVER_CATALOG (vetted by us)
 *   federated    — synced from a real GitHub repo or a sitemap pointing at one;
 *                  the install command corresponds to a verifiable package
 *   ai-generated — produced by Claude from a user description via the generate
 *                  endpoint. The install command is a best-guess and may
 *                  reference packages that don't actually exist — the UI
 *                  surfaces an explicit "concept only, verify before running"
 *                  warning on items with this provenance.
 */
export type DiscoverProvenance = 'curated' | 'federated' | 'ai-generated';

export interface DiscoverItem {
  id: string;                       // Stable kebab-case slug
  name: string;                     // Display name
  type: DiscoverItemType;
  category: DiscoverCategory;
  description: string;              // One-sentence summary
  /** Longer narrative — what it does, when to use it, gotchas. */
  longDescription?: string;
  /** Copy-pasteable install command (npx, uvx, pip, etc.) or canvas snippet. */
  installCommand: string;
  /** Optional config/JSON snippet to add to claude_desktop_config.json or canvas. */
  configSnippet?: string;
  /** Required env vars — usually map to credentials in the vault. */
  requiredEnvVars?: string[];
  /** Original source URL (GitHub repo, docs, marketplace listing). */
  sourceUrl?: string;
  /** Author / maintainer name (e.g., "Anthropic", "modelcontextprotocol"). */
  author?: string;
  /** Searchable tags. */
  tags: string[];
  /** Capability hooks the Fixer can match on. */
  capabilities?: string[];
  /** Trust signal — see DiscoverProvenance docstring. */
  provenance?: DiscoverProvenance;
}

// -----------------------------------------------------------------------------
// Catalog
// -----------------------------------------------------------------------------

export const DISCOVER_CATALOG: DiscoverItem[] = [
  // ───── MCP Servers (official + popular) ─────────────────────────────────
  {
    id: 'mcp-brave-search',
    name: 'Brave Search',
    type: 'mcp',
    category: 'web-search',
    description: 'Web search via Brave Search API — independent index, AI-optimized results.',
    longDescription:
      'Official MCP server for Brave Search. Returns ranked web results, news, and image search. Best default for general web search inside an agent — independent of Google/Bing rate limits.',
    installCommand: 'npx -y @modelcontextprotocol/server-brave-search',
    configSnippet: `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-brave-search"],
  "env": { "BRAVE_API_KEY": "<your-key>" }
}`,
    requiredEnvVars: ['BRAVE_API_KEY'],
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    author: 'Anthropic',
    tags: ['search', 'web', 'official'],
    capabilities: ['web-search', 'real-time-data'],
  },
  {
    id: 'mcp-github',
    name: 'GitHub',
    type: 'mcp',
    category: 'developer-tools',
    description: 'Official GitHub MCP — repos, issues, PRs, code search, file CRUD.',
    longDescription:
      'Comprehensive GitHub integration. Lets agents read/write files in repos, manage issues/PRs, search code, and trigger workflows. The default choice when an agent needs to interact with a repo.',
    installCommand: 'npx -y @modelcontextprotocol/server-github',
    configSnippet: `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<your-token>" }
}`,
    requiredEnvVars: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    author: 'Anthropic',
    tags: ['github', 'git', 'developer', 'official'],
    capabilities: ['code-management', 'issue-tracking', 'pr-review'],
  },
  {
    id: 'mcp-filesystem',
    name: 'Filesystem',
    type: 'mcp',
    category: 'developer-tools',
    description: 'Scoped filesystem access — read/write/list within allowed directories.',
    longDescription:
      'Lets agents work with local files inside a sandboxed directory tree. Supports read, write, edit, list, and search operations. Agent SDK runs scope this per-execution to a workspace.',
    installCommand: 'npx -y @modelcontextprotocol/server-filesystem /path/to/allowed/dir',
    configSnippet: `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
}`,
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    author: 'Anthropic',
    tags: ['files', 'storage', 'official'],
    capabilities: ['file-io', 'sandboxed'],
  },
  {
    id: 'mcp-slack',
    name: 'Slack',
    type: 'mcp',
    category: 'communication',
    description: 'Slack workspace integration — read/post messages, manage channels.',
    longDescription:
      'Two-way Slack bot integration. Agents can read message history, post replies, react with emoji, upload files, and manage channels. Requires a bot token from your Slack app.',
    installCommand: 'npx -y @modelcontextprotocol/server-slack',
    configSnippet: `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-slack"],
  "env": {
    "SLACK_BOT_TOKEN": "<xoxb-token>",
    "SLACK_TEAM_ID": "<team-id>"
  }
}`,
    requiredEnvVars: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
    author: 'Anthropic',
    tags: ['slack', 'chat', 'messaging', 'official'],
    capabilities: ['messaging', 'chat-ingress'],
  },
  {
    id: 'mcp-postgres',
    name: 'PostgreSQL',
    type: 'mcp',
    category: 'data',
    description: 'Read-only Postgres access — schema inspection + parameterized queries.',
    longDescription:
      'Lets agents inspect database schemas and run read-only queries. Safer than full DB access for analytical workflows. Use a least-privilege role for the connection string.',
    installCommand: 'npx -y @modelcontextprotocol/server-postgres postgresql://user:pass@host/db',
    configSnippet: `{
  "command": "npx",
  "args": [
    "-y",
    "@modelcontextprotocol/server-postgres",
    "postgresql://user:pass@host/db"
  ]
}`,
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
    author: 'Anthropic',
    tags: ['database', 'sql', 'postgres', 'official'],
    capabilities: ['sql-query', 'schema-inspection'],
  },
  {
    id: 'mcp-sqlite',
    name: 'SQLite',
    type: 'mcp',
    category: 'data',
    description: 'Local SQLite database access — query and modify rows.',
    installCommand: 'npx -y @modelcontextprotocol/server-sqlite /path/to/db.sqlite',
    configSnippet: `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-sqlite", "/path/to/db.sqlite"]
}`,
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
    author: 'Anthropic',
    tags: ['database', 'sql', 'sqlite', 'official'],
    capabilities: ['sql-query', 'data-storage'],
  },
  {
    id: 'mcp-sequential-thinking',
    name: 'Sequential Thinking',
    type: 'mcp',
    category: 'reasoning',
    description: 'Step-by-step structured reasoning tool — externalize the chain of thought.',
    longDescription:
      'Gives an agent an explicit thinking workspace. Use when a task benefits from showing reasoning steps to the user (debugging, planning, math). Creates more deliberate, verifiable agent behavior.',
    installCommand: 'npx -y @modelcontextprotocol/server-sequential-thinking',
    configSnippet: `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
}`,
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    author: 'Anthropic',
    tags: ['reasoning', 'thinking', 'official'],
    capabilities: ['structured-reasoning', 'planning'],
  },
  {
    id: 'mcp-memory',
    name: 'Memory (Knowledge Graph)',
    type: 'mcp',
    category: 'data',
    description: 'Persistent knowledge graph memory — entities, relations, observations.',
    longDescription:
      'Lets an agent store and retrieve facts across sessions in a structured graph. Useful for personal assistants, research workflows, or any system that needs to remember context beyond a single conversation.',
    installCommand: 'npx -y @modelcontextprotocol/server-memory',
    configSnippet: `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-memory"]
}`,
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    author: 'Anthropic',
    tags: ['memory', 'knowledge-graph', 'persistence', 'official'],
    capabilities: ['long-term-memory', 'knowledge-storage'],
  },
  {
    id: 'mcp-fetch',
    name: 'Fetch',
    type: 'mcp',
    category: 'web-search',
    description: 'HTTP fetch tool — retrieve and convert web content to clean markdown.',
    longDescription:
      'Fetches a URL and returns its content as markdown, with optional truncation. Lighter than puppeteer when you just need to read a page.',
    installCommand: 'uvx mcp-server-fetch',
    configSnippet: `{
  "command": "uvx",
  "args": ["mcp-server-fetch"]
}`,
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    author: 'Anthropic',
    tags: ['http', 'fetch', 'web', 'official', 'python'],
    capabilities: ['url-fetching', 'markdown-conversion'],
  },
  {
    id: 'mcp-puppeteer',
    name: 'Puppeteer',
    type: 'mcp',
    category: 'scraping',
    description: 'Browser automation — navigate, click, screenshot, evaluate JS in real pages.',
    longDescription:
      'Headless Chrome via Puppeteer. Heavier than fetch but handles JS-rendered sites, login flows, and dynamic content. Use when fetch returns empty or broken markdown.',
    installCommand: 'npx -y @modelcontextprotocol/server-puppeteer',
    configSnippet: `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-puppeteer"]
}`,
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
    author: 'Anthropic',
    tags: ['browser', 'puppeteer', 'scraping', 'official'],
    capabilities: ['browser-automation', 'js-rendering', 'screenshots'],
  },
  {
    id: 'mcp-google-drive',
    name: 'Google Drive',
    type: 'mcp',
    category: 'storage',
    description: 'Google Drive search + read access — list files, fetch contents.',
    installCommand: 'npx -y @modelcontextprotocol/server-gdrive',
    configSnippet: `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-gdrive"]
}`,
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive',
    author: 'Anthropic',
    tags: ['google', 'drive', 'storage', 'official'],
    capabilities: ['cloud-storage', 'file-search'],
  },
  {
    id: 'mcp-google-maps',
    name: 'Google Maps',
    type: 'mcp',
    category: 'productivity',
    description: 'Google Maps API — geocoding, directions, place search.',
    installCommand: 'npx -y @modelcontextprotocol/server-google-maps',
    configSnippet: `{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-google-maps"],
  "env": { "GOOGLE_MAPS_API_KEY": "<your-key>" }
}`,
    requiredEnvVars: ['GOOGLE_MAPS_API_KEY'],
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps',
    author: 'Anthropic',
    tags: ['google', 'maps', 'geocoding', 'official'],
    capabilities: ['geocoding', 'directions', 'place-search'],
  },
  {
    id: 'mcp-everart',
    name: 'EverArt',
    type: 'mcp',
    category: 'productivity',
    description: 'AI image generation via EverArt API — multiple model options.',
    installCommand: 'npx -y @modelcontextprotocol/server-everart',
    requiredEnvVars: ['EVERART_API_KEY'],
    sourceUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everart',
    author: 'Anthropic',
    tags: ['image-generation', 'ai', 'official'],
    capabilities: ['image-generation'],
  },
  {
    id: 'mcp-notion',
    name: 'Notion',
    type: 'mcp',
    category: 'productivity',
    description: 'Notion workspace — read/write pages, databases, blocks.',
    longDescription:
      'Community MCP server for Notion. Lets agents query databases, create/update pages, and append blocks. Requires a Notion integration token with workspace access.',
    installCommand: 'npx -y @suekou/mcp-notion-server',
    configSnippet: `{
  "command": "npx",
  "args": ["-y", "@suekou/mcp-notion-server"],
  "env": { "NOTION_API_TOKEN": "<integration-token>" }
}`,
    requiredEnvVars: ['NOTION_API_TOKEN'],
    sourceUrl: 'https://github.com/suekou/mcp-notion-server',
    author: 'suekou',
    tags: ['notion', 'documents', 'community'],
    capabilities: ['document-editing', 'database-query'],
  },
  {
    id: 'mcp-linear',
    name: 'Linear',
    type: 'mcp',
    category: 'productivity',
    description: 'Linear issue tracker — query issues, projects, cycles, comment.',
    installCommand: 'npx -y mcp-linear',
    configSnippet: `{
  "command": "npx",
  "args": ["-y", "mcp-linear"],
  "env": { "LINEAR_API_KEY": "<your-key>" }
}`,
    requiredEnvVars: ['LINEAR_API_KEY'],
    sourceUrl: 'https://github.com/jerhadf/linear-mcp-server',
    author: 'jerhadf',
    tags: ['linear', 'issue-tracker', 'community'],
    capabilities: ['issue-tracking', 'project-management'],
  },

  // ───── Skills (Claude Code skills) ──────────────────────────────────────
  {
    id: 'skill-web-research',
    name: 'Web Research',
    type: 'skill',
    category: 'research',
    description: 'Multi-source web research with citations — pairs with Brave/Tavily MCPs.',
    longDescription:
      'A research skill that decomposes a question into sub-queries, runs them in parallel, dedupes sources, and produces a structured answer with inline citations. Pair with brave-search or tavily MCPs.',
    installCommand: 'autopilate skill add web-research',
    sourceUrl: 'https://buildwithclaude.com/skills/web-research',
    author: 'community',
    tags: ['research', 'search', 'citations'],
    capabilities: ['multi-source-research', 'citation-tracking'],
  },
  {
    id: 'skill-brand-voice',
    name: 'Brand Voice',
    type: 'skill',
    category: 'content',
    description: 'Match writing to a brand style guide — vocabulary, tone, do-not-use list.',
    longDescription:
      'Loads a brand voice document (style guide, do/don\'t list, example writing) and rewrites or generates content that matches. Useful for marketing teams that need consistent output across writers.',
    installCommand: 'autopilate skill add brand-voice',
    sourceUrl: 'https://skills.sh/brand-voice',
    author: 'community',
    tags: ['writing', 'marketing', 'style'],
    capabilities: ['style-matching', 'content-rewriting'],
  },
  {
    id: 'skill-code-review',
    name: 'Code Review',
    type: 'skill',
    category: 'developer-tools',
    description: 'Review PRs and diffs against a configurable rubric of quality + security rules.',
    longDescription:
      'Walks a diff hunk-by-hunk, checks against a YAML rubric (security, performance, style, test coverage), and emits inline comments. Pairs naturally with the GitHub MCP.',
    installCommand: 'autopilate skill add code-review',
    sourceUrl: 'https://buildwithclaude.com/skills/code-review',
    author: 'community',
    tags: ['code', 'review', 'security', 'developer'],
    capabilities: ['diff-review', 'security-scanning'],
  },
  {
    id: 'skill-data-extraction',
    name: 'Data Extraction',
    type: 'skill',
    category: 'data',
    description: 'Extract structured JSON from unstructured text — receipts, contracts, articles.',
    installCommand: 'autopilate skill add data-extraction',
    sourceUrl: 'https://skills.sh/data-extraction',
    author: 'community',
    tags: ['extraction', 'parsing', 'structured-output'],
    capabilities: ['structured-extraction', 'schema-mapping'],
  },
  {
    id: 'skill-summarization',
    name: 'Long-Doc Summarization',
    type: 'skill',
    category: 'content',
    description: 'Summarize long documents with map-reduce — preserves key facts and quotes.',
    installCommand: 'autopilate skill add summarization',
    sourceUrl: 'https://skills.sh/summarization',
    author: 'community',
    tags: ['summarization', 'long-context', 'content'],
    capabilities: ['summarization', 'long-context'],
  },
  {
    id: 'skill-technical-writing',
    name: 'Technical Writing',
    type: 'skill',
    category: 'content',
    description: 'Generate docs, tutorials, API references in a consistent voice.',
    installCommand: 'autopilate skill add technical-writing',
    sourceUrl: 'https://buildwithclaude.com/skills/technical-writing',
    author: 'community',
    tags: ['docs', 'writing', 'tutorials'],
    capabilities: ['doc-generation', 'tutorial-writing'],
  },

  // ───── Prompt templates ─────────────────────────────────────────────────
  {
    id: 'prompt-research-assistant',
    name: 'Research Assistant',
    type: 'prompt',
    category: 'research',
    description: 'System prompt template for a thorough, citation-aware research agent.',
    installCommand: 'autopilate prompt add research-assistant',
    sourceUrl: 'https://github.com/anthropics/anthropic-cookbook',
    author: 'anthropic-cookbook',
    tags: ['research', 'system-prompt', 'template'],
    capabilities: ['research', 'citation'],
  },
  {
    id: 'prompt-pair-programmer',
    name: 'Pair Programmer',
    type: 'prompt',
    category: 'developer-tools',
    description: 'System prompt for collaborative coding — explains decisions, suggests tests.',
    installCommand: 'autopilate prompt add pair-programmer',
    sourceUrl: 'https://github.com/anthropics/anthropic-cookbook',
    author: 'anthropic-cookbook',
    tags: ['coding', 'system-prompt', 'developer'],
    capabilities: ['code-assistance', 'test-suggestion'],
  },
  {
    id: 'prompt-meeting-summarizer',
    name: 'Meeting Summarizer',
    type: 'prompt',
    category: 'productivity',
    description: 'Turn meeting transcripts into structured notes — decisions, action items, owners.',
    installCommand: 'autopilate prompt add meeting-summarizer',
    sourceUrl: 'https://github.com/anthropics/anthropic-cookbook',
    author: 'anthropic-cookbook',
    tags: ['meetings', 'summarization', 'productivity'],
    capabilities: ['summarization', 'action-extraction'],
  },
];

// -----------------------------------------------------------------------------
// Stamp provenance on every curated entry at module load — cheaper than
// repeating `provenance: 'curated'` on 25+ inline entries, and keeps the
// catalog data clean.
// -----------------------------------------------------------------------------
for (const item of DISCOVER_CATALOG) {
  if (!item.provenance) item.provenance = 'curated';
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

export function getDiscoverItem(id: string): DiscoverItem | undefined {
  return DISCOVER_CATALOG.find((i) => i.id === id);
}

export function findDiscoverItemsByCapability(capability: string): DiscoverItem[] {
  return DISCOVER_CATALOG.filter((i) => i.capabilities?.includes(capability) ?? false);
}

export function findDiscoverItemsByCategory(category: DiscoverCategory): DiscoverItem[] {
  return DISCOVER_CATALOG.filter((i) => i.category === category);
}

export function findDiscoverItemsByType(type: DiscoverItemType): DiscoverItem[] {
  return DISCOVER_CATALOG.filter((i) => i.type === type);
}

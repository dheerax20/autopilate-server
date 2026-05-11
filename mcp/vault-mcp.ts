// =============================================================================
// Vault MCP Tools — agent-facing interface for the persistent vault
//
// Exposed as MCP tools that OrchestratorCore can mount per-execution
// alongside the filesystem MCP. Agents call these to store artifacts
// for future executions and retrieve prior artifacts for context.
//
// Tools:
//   vault_store  — persist an artifact with title, content, tags
//   vault_search — hybrid keyword + semantic search over prior artifacts
//   vault_get    — retrieve a specific artifact by ID
//   vault_list   — list artifacts by tag (optionally filtered by system)
// =============================================================================

import {
  vaultStore,
  vaultSearch,
  vaultGet,
  vaultListByTag,
  type VaultStoreInput,
} from '../services/vault';

// Tool definitions in the Anthropic tool format — these get passed to
// the Agent SDK via mcpServers or injected directly into the tools list.
// For now, we expose them as callable functions that the orchestrator
// wires up as a custom MCP server via the Agent SDK's
// createSdkMcpServer() helper.

export interface VaultToolInput {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Execute a vault tool call. Returns the result as a string (MCP content).
 */
export async function executeVaultTool(
  toolName: string,
  input: Record<string, unknown>,
  executionContext: { systemSlug: string; executionId: string; agentLabel: string }
): Promise<string> {
  switch (toolName) {
    case 'vault_store': {
      const storeInput: VaultStoreInput = {
        systemSlug: executionContext.systemSlug,
        executionId: executionContext.executionId,
        agentLabel: executionContext.agentLabel,
        title: String(input.title ?? 'Untitled'),
        content: String(input.content ?? ''),
        tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
        metadata: (input.metadata as Record<string, unknown>) ?? {},
      };
      const artifact = await vaultStore(storeInput);
      return JSON.stringify({
        success: true,
        id: artifact.id,
        message: `Artifact "${artifact.title}" stored successfully.`,
      });
    }

    case 'vault_search': {
      const results = await vaultSearch({
        query: String(input.query ?? ''),
        systemSlug: input.system_slug as string | undefined,
        tags: Array.isArray(input.tags) ? input.tags.map(String) : undefined,
        limit: typeof input.limit === 'number' ? input.limit : 10,
        mode: (input.mode as 'semantic' | 'keyword' | 'hybrid') ?? 'hybrid',
      });
      return JSON.stringify({
        results: results.map((r) => ({
          id: r.id,
          title: r.title,
          agent: r.agentLabel,
          system: r.systemSlug,
          score: r.score,
          tags: r.tags,
          preview: r.content.slice(0, 500),
          createdAt: r.createdAt,
        })),
        total: results.length,
      });
    }

    case 'vault_get': {
      const id = String(input.id ?? '');
      const artifact = await vaultGet(id);
      if (!artifact) {
        return JSON.stringify({ error: `Artifact ${id} not found.` });
      }
      return JSON.stringify(artifact);
    }

    case 'vault_list': {
      const tag = String(input.tag ?? '');
      const systemSlug = input.system_slug as string | undefined;
      const limit = typeof input.limit === 'number' ? input.limit : 20;
      const artifacts = await vaultListByTag(tag, systemSlug, limit);
      return JSON.stringify({
        results: artifacts.map((a) => ({
          id: a.id,
          title: a.title,
          agent: a.agentLabel,
          system: a.systemSlug,
          tags: a.tags,
          createdAt: a.createdAt,
        })),
        total: artifacts.length,
      });
    }

    default:
      return JSON.stringify({ error: `Unknown vault tool: ${toolName}` });
  }
}

/**
 * Tool definitions in Anthropic tool format. Used by the orchestrator
 * to expose vault tools alongside MCP servers.
 */
export const VAULT_TOOL_DEFINITIONS = [
  {
    name: 'vault_store',
    description: 'Store an artifact in the persistent vault for future executions to reference. Use this to save research findings, generated content, audit reports, or any output worth preserving across runs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short descriptive title for the artifact' },
        content: { type: 'string', description: 'Full content of the artifact (markdown)' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization and filtering (e.g., ["research", "competitive-analysis"])',
        },
        metadata: {
          type: 'object',
          description: 'Optional key-value metadata (e.g., {"client": "acme", "project": "rebrand"})',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'vault_search',
    description: 'Search the vault for prior artifacts by keyword, semantic similarity, or both. Returns matching artifacts ranked by relevance.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (natural language or keywords)' },
        system_slug: { type: 'string', description: 'Filter to artifacts from a specific system (optional)' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to artifacts with any of these tags (optional)',
        },
        limit: { type: 'number', description: 'Max results to return (default 10)' },
        mode: {
          type: 'string',
          enum: ['hybrid', 'semantic', 'keyword'],
          description: 'Search mode: hybrid (default), semantic-only, or keyword-only',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'vault_get',
    description: 'Retrieve a specific artifact by its ID. Use this after vault_search to get the full content of a result.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The artifact UUID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'vault_list',
    description: 'List artifacts with a specific tag, optionally filtered by system. Returns newest first.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tag: { type: 'string', description: 'The tag to filter by' },
        system_slug: { type: 'string', description: 'Filter to a specific system (optional)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['tag'],
    },
  },
];

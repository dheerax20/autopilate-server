// =============================================================================
// Discover Generator
//
// Turns a user description ("Datadog MCP server for sending custom metrics")
// into a DiscoverItem JSON. Persisted via discover-store and merged into the
// catalog by discover-registry, so generated entries are immediately visible
// in the picker.
//
// Model: BUILDER pool / Sonnet 4.5 — same routing as provider-generator
// because the Architect/Router workspaces are model-scoped on the user's
// account. Sonnet handles structured JSON reliably at ~1-2s latency.
// =============================================================================

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { smartGenerate } from '../lib/anthropic-client';
import { upsertCustomDiscoverItem } from './discover-store';
import { getDiscoverItem as getCatalogItem } from './discover-catalog';
import type { DiscoverItem } from './discover-catalog';

// -----------------------------------------------------------------------------
// Validation schema
// -----------------------------------------------------------------------------

const discoverItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be lowercase-kebab-case'),
  name: z.string().min(1).max(120),
  type: z.enum(['mcp', 'skill', 'prompt', 'agent', 'subagent', 'command', 'hook', 'plugin']),
  category: z.enum([
    'web-search', 'scraping', 'data', 'storage', 'communication',
    'productivity', 'ai-models', 'developer-tools', 'research',
    'content', 'reasoning', 'other',
  ]),
  description: z.string().min(1).max(280),
  longDescription: z.string().max(2000).optional(),
  installCommand: z.string().min(1).max(500),
  configSnippet: z.string().max(2000).optional(),
  requiredEnvVars: z.array(z.string()).max(10).optional(),
  sourceUrl: z.string().url().optional(),
  author: z.string().max(120).optional(),
  tags: z.array(z.string()).min(1).max(10),
  capabilities: z.array(z.string()).max(10).optional(),
});

// -----------------------------------------------------------------------------
// System prompt
// -----------------------------------------------------------------------------

const SYSTEM_PROMPT = `You generate DiscoverItem definitions for the AUTOPILATE marketplace.

Given a short description of an MCP server, Claude skill, prompt template, or agent that a user wants to add to AUTOPILATE, return a single JSON object matching this TypeScript shape (NO markdown, NO code fences, JUST raw JSON):

{
  "id": "kebab-case slug, prefixed by type — e.g. 'mcp-cohere', 'skill-translate', 'prompt-tutor'",
  "name": "Display name (e.g. 'Cohere LLM' or 'Code Reviewer')",
  "type": "mcp" | "skill" | "prompt" | "agent",
  "category": "web-search" | "scraping" | "data" | "storage" | "communication" | "productivity" | "ai-models" | "developer-tools" | "research" | "content" | "reasoning" | "other",
  "description": "One-sentence summary (max 280 chars)",
  "longDescription": "Optional 2-3 sentence detail about what it does, when to use it, gotchas",
  "installCommand": "Copy-pasteable install command (npx, uvx, pip, etc.) OR canvas snippet",
  "configSnippet": "Optional JSON config block — e.g. for claude_desktop_config.json or canvas MCP node",
  "requiredEnvVars": ["ARRAY_OF_ENV_VAR_NAMES"],
  "sourceUrl": "Direct URL to GitHub repo / docs / marketplace listing",
  "author": "Maintainer (e.g. 'Anthropic', 'modelcontextprotocol', 'community')",
  "tags": ["lowercase", "searchable", "tags"],
  "capabilities": ["lowercase-kebab-case", "capability-tags"]
}

CRITICAL RULES:
- Output ONLY the JSON object — no explanation, no markdown, no code fences
- The id MUST be kebab-case prefixed by type — "mcp-X", "skill-X", "prompt-X", "agent-X"
- For MCP servers: prefer the official @modelcontextprotocol/server-X package if it exists
- For MCP servers: ALWAYS include a configSnippet showing how to add it to claude_desktop_config.json
- For MCP servers needing API keys: list them in requiredEnvVars (e.g. ["BRAVE_API_KEY"])
- For skills: installCommand should be the autopilate CLI form ("autopilate skill add X")
- For prompts: installCommand should be ("autopilate prompt add X")
- ONLY include sourceUrl if you're confident about the exact URL — otherwise omit
- ONLY include 1 author / 1 sourceUrl — don't make up multiple
- tags must be lowercase, kebab-case where multi-word
- Keep descriptions concise and actionable
- If you don't know the package, return your best-guess JSON anyway with a clear note in description
- Don't invent install commands for services you don't actually know about — if unsure, use a generic placeholder like "npx -y @org/package-name" and let the user fix it`;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export class DiscoverGenerationError extends Error {
  constructor(message: string, public raw?: string) {
    super(message);
    this.name = 'DiscoverGenerationError';
  }
}

export interface GenerationResult {
  item: DiscoverItem;
  warnings: string[];
}

export async function generateDiscoverItem(
  description: string,
  options: {
    createdBy?: string;
    /** When set, pins the type instead of letting Claude guess from the description. */
    typeHint?: DiscoverItem['type'];
  } = {}
): Promise<GenerationResult> {
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    throw new DiscoverGenerationError('Description is empty');
  }
  if (trimmed.length > 2000) {
    throw new DiscoverGenerationError('Description is too long (max 2000 chars)');
  }

  const typeDirective = options.typeHint
    ? `\n\nThe item type is fixed: "${options.typeHint}". Use that as the "type" field — do NOT infer a different type from the description.`
    : '';

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Service description: ${trimmed}${typeDirective}\n\nReturn the DiscoverItem JSON now.`,
    },
  ];

  const response = await smartGenerate('BUILDER', SYSTEM_PROMPT, messages);

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const stripped = text
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new DiscoverGenerationError(
      `Model returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      stripped
    );
  }

  const validation = discoverItemSchema.safeParse(parsed);
  if (!validation.success) {
    const firstIssue = validation.error.issues[0];
    throw new DiscoverGenerationError(
      `Generated item failed schema validation: ${firstIssue.path.join('.')} — ${firstIssue.message}`,
      stripped
    );
  }

  const generated = validation.data as DiscoverItem;
  // Every item that comes out of this function is a Claude hallucination until
  // proven otherwise — tag it so the UI can show the "Concept — verify install
  // command before running" warning banner on the detail drawer.
  generated.provenance = 'ai-generated';
  const warnings: string[] = [];

  // Collision check: don't let a generated item overwrite a curated one.
  if (getCatalogItem(generated.id)) {
    const altId = `${generated.id}-custom`;
    warnings.push(
      `"${generated.id}" is already a curated item — saving as "${altId}" instead`
    );
    generated.id = altId;
  }

  const saved = await upsertCustomDiscoverItem(generated, options.createdBy);

  return { item: saved, warnings };
}

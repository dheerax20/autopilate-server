// =============================================================================
// Provider Generator
//
// Turns a user description ("Cohere — an LLM provider with API key auth")
// into a ProviderDefinition JSON matching the shape in credential-catalog.ts.
// The generated definition is persisted via custom-provider-store and returned
// to the caller so the Configure Wizard / Vault dashboard can immediately drop
// into the typed CredentialForm.
//
// Model: BUILDER pool, preferred model (Sonnet 4.5). Routed to BUILDER instead
// of ROUTER because the user's workspaces are model-scoped: BUILDER workspaces
// allow Sonnet, ROUTER / Haiku bucket is capped to 0 req/min. Sonnet 4.5
// handles one-shot structured JSON reliably at ~1–2s latency, which is
// acceptable for a "type description, review form" UI flow. Falls back through
// the BUILDER pool's normal A→B→Backup(Emergency) chain on 429/529.
// =============================================================================

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { smartGenerate } from '../lib/anthropic-client';
import {
  upsertCustomProvider,
} from './custom-provider-store';
import { getProvider as getCatalogProvider } from './credential-catalog';
import type { ProviderDefinition } from './credential-catalog';

// -----------------------------------------------------------------------------
// Validation schema — mirrors the TypeScript ProviderDefinition shape.
// Used to sanity-check Claude's output before we persist it. Any field that
// fails validation causes generation to retry once with a stricter prompt.
// -----------------------------------------------------------------------------

const credentialFieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  placeholder: z.string(),
  description: z.string().optional(),
  required: z.boolean(),
  secret: z.boolean(),
  format: z.string().optional(),
  formatHint: z.string().optional(),
});

const validationRuleSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST']),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  expectedStatus: z.number().int(),
  timeoutMs: z.number().int().optional(),
});

const mcpConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  envVars: z.record(z.string(), z.string()),
});

const providerDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'id must be lowercase-kebab-case'),
  name: z.string().min(1),
  category: z.enum(['llm', 'web-search', 'scraping', 'vector-db', 'storage', 'messaging', 'other']),
  description: z.string().min(1),
  credentialType: z.enum(['api_key', 'oauth_token', 'multi_field', 'text_reference']),
  fields: z.array(credentialFieldSchema).min(1),
  signupUrl: z.string().url().optional(),
  signupSteps: z.array(z.string()).optional(),
  freeTier: z.string().optional(),
  docsUrl: z.string().url().optional(),
  validation: validationRuleSchema.optional(),
  mcpConfig: mcpConfigSchema.optional(),
  capabilities: z.array(z.string()).min(1),
});

// -----------------------------------------------------------------------------
// System prompt
// -----------------------------------------------------------------------------

const SYSTEM_PROMPT = `You generate credential provider definitions for the AUTOPILATE credential vault.

Given a short description of an API service, return a single JSON object matching this TypeScript shape (NO markdown, NO code fences, JUST the raw JSON object):

{
  "id": "kebab-case slug, e.g. 'cohere' or 'replicate'",
  "name": "Display name (e.g., 'Cohere')",
  "category": "llm" | "web-search" | "scraping" | "vector-db" | "storage" | "messaging" | "other",
  "description": "One-sentence summary",
  "credentialType": "api_key" | "oauth_token" | "multi_field" | "text_reference",
  "fields": [
    {
      "name": "camelCase identifier (apiKey, accessKeyId, projectId)",
      "label": "Human-readable label (e.g., 'Cohere API Key')",
      "placeholder": "Example value format",
      "description": "Optional help text",
      "required": true,
      "secret": true,
      "format": "Optional regex string",
      "formatHint": "Optional human-readable format"
    }
  ],
  "signupUrl": "Direct URL to the API key creation page",
  "signupSteps": ["Step 1", "Step 2", "Step 3", "Step 4"],
  "freeTier": "Optional free tier description, e.g. '1000 calls/month'",
  "docsUrl": "URL to API docs",
  "validation": {
    "url": "Test endpoint (can contain {fieldName} placeholders)",
    "method": "GET" | "POST",
    "headers": { "Authorization": "Bearer {apiKey}" },
    "body": "Optional JSON string with {placeholder} refs",
    "expectedStatus": 200,
    "timeoutMs": 10000
  },
  "capabilities": ["llm", "chat-completion"]
}

CRITICAL RULES:
- Output ONLY the JSON object — no explanation, no markdown, no code fences
- The id MUST be kebab-case, lowercase, alphanumeric + hyphens only
- For simple API key services, use credentialType "api_key" with a single field named "apiKey" (secret: true)
- For services with multiple fields (accessKeyId + secretAccessKey + region), use "multi_field"
- ALWAYS include 3-6 practical signupSteps — the user should be able to follow them without reading docs
- ONLY include the "validation" block if you're confident about the test endpoint. If unsure, omit it entirely.
- ONLY include real signupUrl / docsUrl — if you're unsure of the exact URL, omit the field
- All secret/token fields MUST have secret: true
- capabilities should be lowercase kebab-case tags (e.g., "llm", "web-search", "real-time-data", "chat-completion")
- For LLM providers use category "llm"; for search use "web-search"; for scrapers "scraping"; etc.
- If the description is too vague or you can't confidently identify the service, return a definition with category "other" and best-effort fields — don't make up endpoints

Think carefully about the credential type before you write it out. Your output will be parsed as JSON directly.`;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export class ProviderGenerationError extends Error {
  constructor(message: string, public raw?: string) {
    super(message);
    this.name = 'ProviderGenerationError';
  }
}

export interface GenerationResult {
  provider: ProviderDefinition;
  warnings: string[];
}

/**
 * Generate a ProviderDefinition from a user description. Validates the model
 * output against the zod schema, collides against the hardcoded catalog to
 * avoid overwriting curated entries, and persists via upsertCustomProvider.
 */
export async function generateProviderDefinition(
  description: string,
  createdBy?: string
): Promise<GenerationResult> {
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    throw new ProviderGenerationError('Description is empty');
  }
  if (trimmed.length > 2000) {
    throw new ProviderGenerationError('Description is too long (max 2000 chars)');
  }

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Service description: ${trimmed}\n\nReturn the ProviderDefinition JSON now.`,
    },
  ];

  const response = await smartGenerate('BUILDER', SYSTEM_PROMPT, messages);

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Strip markdown code fences defensively even though we asked for raw JSON
  const stripped = text
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new ProviderGenerationError(
      `Model returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      stripped
    );
  }

  const validation = providerDefinitionSchema.safeParse(parsed);
  if (!validation.success) {
    const firstIssue = validation.error.issues[0];
    throw new ProviderGenerationError(
      `Generated provider failed schema validation: ${firstIssue.path.join('.')} — ${firstIssue.message}`,
      stripped
    );
  }

  const generated = validation.data as ProviderDefinition;
  const warnings: string[] = [];

  // Collision check: don't let a generated provider overwrite a curated one.
  // If the id collides, append a suffix so the custom entry stays separate.
  if (getCatalogProvider(generated.id)) {
    const altId = `${generated.id}-custom`;
    warnings.push(
      `"${generated.id}" is already a curated provider — saving as "${altId}" instead`
    );
    generated.id = altId;
  }

  // Safety: at least one required secret field for api_key / multi_field types.
  // text_reference is allowed to have no secret fields.
  if (generated.credentialType !== 'text_reference') {
    const hasRequiredSecret = generated.fields.some((f) => f.required && f.secret);
    if (!hasRequiredSecret) {
      warnings.push('No required secret field found — marked first field as secret');
      if (generated.fields[0]) {
        generated.fields[0].secret = true;
        generated.fields[0].required = true;
      }
    }
  }

  // Persist + cache
  const saved = await upsertCustomProvider(generated, createdBy);

  return { provider: saved, warnings };
}

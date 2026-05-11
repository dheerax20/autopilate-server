// =============================================================================
// Discover Relevance Ranker
//
// Takes the pool of search candidates (local catalog + external hits), ships
// them to Claude with the user's original description, and receives back a
// ranked subset with 1-2 sentence reasoning per item. The ranker lets us
// surface the best matches even when the input pool is noisy — sitemap
// keyword filters cast a wide net, and Claude picks out what actually fits.
//
// Model: BUILDER pool / Sonnet 4.5 — same routing as provider-generator
// because the user's workspaces are model-scoped. Sonnet handles the
// structured output reliably at ~2s latency for ~30-50 candidate pools.
// =============================================================================

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { smartGenerate } from '../../lib/anthropic-client';
import type { SearchCandidate } from './external-search';

// -----------------------------------------------------------------------------
// Ranked result schema (what we expect Claude to return)
// -----------------------------------------------------------------------------

const rankedResultsSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string(),
        score: z.number().min(0).max(1),
        reasoning: z.string().min(1).max(400),
      })
    )
    .max(20),
});

const SYSTEM_PROMPT = `You rank search candidates by relevance to a user's description.

The user is looking for a specific kind of AI asset (MCP server, Claude skill, prompt template, agent, etc.) and describes what they want in a sentence or two. You receive a pool of candidates from multiple sources (their local catalog + live searches of GitHub + mcpservers.org + skills.sh) and must return a ranked subset of the best matches.

Return ONLY a JSON object matching this shape (no markdown, no code fences):

{
  "results": [
    {
      "id": "candidate id from the input",
      "score": 0.0 to 1.0,
      "reasoning": "1-2 sentences explaining WHY this matches"
    }
  ]
}

CRITICAL RULES:
- Return AT MOST 10 results — only the ones that clearly match
- Rank by relevance, best match first
- Only include candidates with score >= 0.35 — if nothing is a plausible match, return an empty array
- The reasoning must be specific to THIS candidate and THIS description — no generic "This could work for you" blurbs
- The id in each result must EXACTLY match an id from the input pool
- Never hallucinate new candidates — every output id must come from the input
- Prefer candidates that clearly name the user's target domain (e.g., "snowflake" for "query Snowflake databases")
- Deprioritize generic starters/templates unless the user explicitly asked for one
- Skip exact duplicates — if two candidates describe the same repo under different source ids, keep only the higher-quality one

Think carefully about the match quality before writing out the JSON.`;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export class RankerError extends Error {
  constructor(message: string, public raw?: string) {
    super(message);
    this.name = 'RankerError';
  }
}

/**
 * Rank a pool of candidates against the user's description. Returns a new
 * array sorted by score descending, with `score` and `reasoning` populated.
 * Candidates not in the ranker's response are dropped from the output.
 */
export async function rankCandidates(
  description: string,
  candidates: SearchCandidate[]
): Promise<SearchCandidate[]> {
  if (candidates.length === 0) return [];

  // Build the minimal candidate payload so the prompt stays small
  const pool = candidates.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    source: c.source,
    author: c.author ?? 'unknown',
    description: (c.description || '(no description available)').slice(0, 400),
  }));

  const userPrompt = `User description: "${description}"

Candidate pool (${pool.length} items):
${JSON.stringify(pool, null, 2)}

Return the ranked JSON now.`;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userPrompt },
  ];

  const response = await smartGenerate('BUILDER', SYSTEM_PROMPT, messages);
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((b) => b.text)
    .join('');
  const stripped = text
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    throw new RankerError(
      `Ranker returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      stripped
    );
  }

  const validation = rankedResultsSchema.safeParse(parsed);
  if (!validation.success) {
    throw new RankerError(
      `Ranker output failed schema validation: ${validation.error.issues[0]?.message ?? 'unknown'}`,
      stripped
    );
  }

  // Build a map for O(1) lookup back to the original candidates
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const ranked: SearchCandidate[] = [];
  for (const result of validation.data.results) {
    const candidate = byId.get(result.id);
    if (!candidate) continue; // Ranker hallucinated an id — drop it
    ranked.push({
      ...candidate,
      score: result.score,
      reasoning: result.reasoning,
    });
  }

  return ranked;
}

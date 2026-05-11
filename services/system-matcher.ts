// =============================================================================
// System Matcher — Semantic classification of inbound messages against deployed
// system manifests using Claude API. Determines which system (if any) a message
// maps to and identifies missing required inputs.
// =============================================================================

import type Anthropic from '@anthropic-ai/sdk';
import { smartGenerate } from '../lib/anthropic-client';
import type { SystemManifest, RequiredInput } from '../types/registry';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SystemMatchResult {
  system: SystemManifest | null;
  confidence: number;
  missingInputs: string[];
}

/** Raw JSON shape returned by the LLM classification prompt. */
interface ClassificationResponse {
  matchedSlug: string | null;
  confidence: number;
  missingInputs: string[];
  reasoning: string;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class SystemMatchError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'SystemMatchError';
  }
}

// -----------------------------------------------------------------------------
// LLM Classification (isolated for test mocking)
// -----------------------------------------------------------------------------

const CLASSIFICATION_SYSTEM_PROMPT = `You are a message classifier for an AI agent orchestration platform.
You receive an inbound user message and a list of deployed system manifests.

Your job:
1. Determine if the message maps to one of the deployed systems.
2. If it does, identify which system and how confident you are (0.0-1.0).
3. Check the matched system's requiredInputs — list any that are NOT clearly
   provided or inferrable from the message.
4. If no system matches, return matchedSlug: null with confidence 0.

Respond with ONLY valid JSON (no markdown fences):
{
  "matchedSlug": "<system slug or null>",
  "confidence": <0.0 to 1.0>,
  "missingInputs": ["<input name>", ...],
  "reasoning": "<one-line explanation>"
}`;

function buildUserPrompt(
  message: string,
  manifests: SystemManifest[]
): string {
  const systemDescriptions = manifests.map((m) => ({
    slug: m.slug,
    name: m.name,
    description: m.description,
    category: m.category,
    requiredInputs: m.requiredInputs.map((i: RequiredInput) => ({
      name: i.name,
      type: i.type,
      description: i.description,
      required: i.required,
    })),
    triggerPattern: m.triggerPattern,
  }));

  return [
    'USER MESSAGE:',
    message,
    '',
    'DEPLOYED SYSTEMS:',
    JSON.stringify(systemDescriptions, null, 2),
  ].join('\n');
}

/**
 * Call Claude to classify a message against system manifests.
 * Exported separately so tests can mock this function without mocking the
 * entire Anthropic client.
 */
export async function classifyMessage(
  message: string,
  manifests: SystemManifest[]
): Promise<ClassificationResponse> {
  const userPrompt = buildUserPrompt(message, manifests);

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userPrompt },
  ];

  // ROUTER pool already has the model configured via ROUTER_MODEL env var
  const response = await smartGenerate(
    'ROUTER',
    CLASSIFICATION_SYSTEM_PROMPT,
    messages
  );

  // Extract text from the response content blocks
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // Strip markdown code fences if the model wrapped its JSON in ```json ... ```
  const stripped = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  try {
    const parsed: ClassificationResponse = JSON.parse(stripped);

    // Clamp confidence to [0, 1]
    parsed.confidence = Math.max(0, Math.min(1, parsed.confidence));
    parsed.missingInputs = parsed.missingInputs ?? [];

    return parsed;
  } catch (err) {
    throw new SystemMatchError(
      `Failed to parse classification response: ${stripped.slice(0, 200)}`,
      err
    );
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/** Minimum confidence threshold to consider a match viable. */
const MATCH_CONFIDENCE_THRESHOLD = 0.4;

/**
 * Match an inbound message to a deployed system manifest.
 *
 * Returns the best matching system (or null), the confidence score, and a list
 * of required inputs that were not provided in the message.
 */
export async function matchSystem(
  message: string,
  systemManifests: SystemManifest[]
): Promise<SystemMatchResult> {
  if (systemManifests.length === 0) {
    return { system: null, confidence: 0, missingInputs: [] };
  }

  const classification = await classifyMessage(message, systemManifests);

  if (
    !classification.matchedSlug ||
    classification.confidence < MATCH_CONFIDENCE_THRESHOLD
  ) {
    return { system: null, confidence: classification.confidence, missingInputs: [] };
  }

  const matched = systemManifests.find(
    (m) => m.slug === classification.matchedSlug
  );

  if (!matched) {
    // LLM hallucinated a slug that doesn't exist — treat as no match
    return { system: null, confidence: 0, missingInputs: [] };
  }

  return {
    system: matched,
    confidence: classification.confidence,
    missingInputs: classification.missingInputs,
  };
}

// =============================================================================
// Input Gatherer — Conversational input collection when the Router Agent
// identified a matching system but the user's message is missing required
// inputs. Generates natural prompts via Claude, collects responses, and
// compiles a structured Brief for system execution.
// =============================================================================

import type Anthropic from '@anthropic-ai/sdk';
import { smartGenerate } from '../lib/anthropic-client';
import type { SystemManifest, RequiredInput } from '../types/registry';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** A compiled set of inputs ready to trigger a system execution. */
export interface Brief {
  systemSlug: string;
  systemName: string;
  inputs: Record<string, string>;
  collectedAt: number;
}

/** Represents a single prompt the gatherer will ask the user. */
interface InputPrompt {
  inputName: string;
  prompt: string;
}

/** Function signature for receiving a user response on a messaging channel. */
export type ChannelResponder = (prompt: string) => Promise<string>;

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class InputGathererError extends Error {
  constructor(
    message: string,
    public readonly step?: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'InputGathererError';
  }
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Hard cap on rounds of follow-up questions to avoid infinite loops. */
const MAX_GATHER_ROUNDS = 10;

// -----------------------------------------------------------------------------
// LLM: Generate Conversational Prompts (isolated for test mocking)
// -----------------------------------------------------------------------------

const PROMPT_GENERATION_SYSTEM = `You generate friendly, natural conversational prompts to collect information from a user.
You receive a system name, its description, and a list of missing inputs with their types and descriptions.
For each missing input, generate a short, natural question that would elicit the needed value.
Return ONLY valid JSON — an array of objects: [{"inputName": "<name>", "prompt": "<question>"}]
Do not use markdown fences.`;

export async function generateInputPrompts(
  system: SystemManifest,
  missingInputs: RequiredInput[]
): Promise<InputPrompt[]> {
  const userContent = [
    `System: ${system.name}`,
    `Description: ${system.description}`,
    '',
    'Missing inputs:',
    JSON.stringify(
      missingInputs.map((i) => ({
        name: i.name,
        type: i.type,
        description: i.description,
      })),
      null,
      2
    ),
  ].join('\n');

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userContent },
  ];

  const response = await smartGenerate(
    'BUILDER',
    PROMPT_GENERATION_SYSTEM,
    messages
  );

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const stripped = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  try {
    const parsed: unknown = JSON.parse(stripped);
    if (!Array.isArray(parsed)) {
      throw new Error('Expected array');
    }
    return parsed.map((item: unknown) => {
      const obj = item as Record<string, unknown>;
      return {
        inputName: String(obj['inputName'] ?? ''),
        prompt: String(obj['prompt'] ?? ''),
      };
    });
  } catch (err) {
    throw new InputGathererError(
      `Failed to parse prompt generation response: ${text.slice(0, 200)}`,
      'generate-prompts',
      err
    );
  }
}

// -----------------------------------------------------------------------------
// LLM: Extract a single input value from user response (isolated for mocking)
// -----------------------------------------------------------------------------

const EXTRACTION_SYSTEM = `You extract a single value from a user's conversational response.
You receive the input name, its type, its description, and the user's message.
Return ONLY valid JSON: {"value": "<extracted value>"}
If the user's response does not contain a usable value, return {"value": null}.
Do not use markdown fences.`;

export async function extractSingleInput(
  inputDef: RequiredInput,
  userResponse: string
): Promise<string | null> {
  const userContent = [
    `Input name: ${inputDef.name}`,
    `Type: ${inputDef.type}`,
    `Description: ${inputDef.description}`,
    '',
    `User response: ${userResponse}`,
  ].join('\n');

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userContent },
  ];

  const response = await smartGenerate('BUILDER', EXTRACTION_SYSTEM, messages);

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  try {
    const parsed = JSON.parse(text) as { value: unknown };
    if (parsed.value === null || parsed.value === undefined) {
      return null;
    }
    return String(parsed.value);
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Gather all missing required inputs for a system by conversing with the user
 * over the messaging channel.
 *
 * @param systemManifest - The system that needs inputs
 * @param message - The original user message (may contain partial inputs)
 * @param channelResponder - Callback that sends a prompt and returns the response
 * @returns A compiled Brief with all inputs
 */
export async function gatherInputs(
  systemManifest: SystemManifest,
  message: string,
  channelResponder: ChannelResponder
): Promise<Brief> {
  const collected: Record<string, string> = {};

  // Identify which required inputs are missing from the original message
  const allRequired = systemManifest.requiredInputs.filter((i) => i.required);
  const missing = identifyMissingInputs(allRequired, message);

  // If everything was already provided, compile immediately
  if (missing.length === 0) {
    return compileBrief(systemManifest, collected);
  }

  // Generate conversational prompts for missing inputs
  const prompts = await generateInputPrompts(systemManifest, missing);

  // Build a lookup for prompts by input name
  const promptMap = new Map<string, string>();
  for (const p of prompts) {
    promptMap.set(p.inputName, p.prompt);
  }

  // Iterate through missing inputs, asking one at a time
  let remaining = [...missing];
  let rounds = 0;

  while (remaining.length > 0 && rounds < MAX_GATHER_ROUNDS) {
    rounds++;
    const current = remaining[0];
    const prompt = promptMap.get(current.name) ?? `What is the ${current.name}?`;

    const userResponse = await channelResponder(prompt);
    const value = await extractSingleInput(current, userResponse);

    if (value !== null) {
      collected[current.name] = value;
      remaining = remaining.filter((i) => i.name !== current.name);
    }
    // If value is null, the loop will re-ask on the next round
  }

  if (remaining.length > 0) {
    throw new InputGathererError(
      `Failed to collect all inputs after ${MAX_GATHER_ROUNDS} rounds. Still missing: ${remaining.map((i) => i.name).join(', ')}`,
      'gather-loop'
    );
  }

  return compileBrief(systemManifest, collected);
}

// -----------------------------------------------------------------------------
// Internal Helpers
// -----------------------------------------------------------------------------

/**
 * Simple heuristic: check which required inputs are NOT mentioned in the
 * original message by name or description keywords. This is a fast pre-filter;
 * the LLM does the actual extraction in the router.
 */
function identifyMissingInputs(
  requiredInputs: RequiredInput[],
  message: string
): RequiredInput[] {
  const lower = message.toLowerCase();
  return requiredInputs.filter((input) => {
    const namePresent = lower.includes(input.name.toLowerCase());
    // Also check if the description's first keyword appears
    const descWords = input.description.toLowerCase().split(/\s+/).slice(0, 3);
    const descHint = descWords.some((w) => w.length > 3 && lower.includes(w));
    return !namePresent && !descHint;
  });
}

function compileBrief(
  manifest: SystemManifest,
  inputs: Record<string, string>
): Brief {
  return {
    systemSlug: manifest.slug,
    systemName: manifest.name,
    inputs,
    collectedAt: Date.now(),
  };
}

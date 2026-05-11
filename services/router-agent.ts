// =============================================================================
// Router Agent — Sits between OpenClaw messaging channels and the Systems
// Library. Classifies inbound messages into one of three actions:
//   1) Direct answer — simple question, respond without triggering a system
//   2) Clarify — message maps to a system but lacks required inputs
//   3) Trigger system — message clearly maps to a system with sufficient context
// =============================================================================

import type Anthropic from '@anthropic-ai/sdk';
import { smartGenerate } from '../lib/anthropic-client';
import { listSystems } from './registry';
import { matchSystem, type SystemMatchResult } from './system-matcher';
import { emitSessionMessage, emitSessionStateChange, emitExecutionLog } from '../socket/emitter';
import type { SystemManifest, DeploymentRecord } from '../types/registry';
import { validateExtractedInputs } from './input-validator';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type RouterDecision =
  | { kind: 'direct-answer'; response: string }
  | { kind: 'clarify'; system: SystemManifest; missingInputs: string[]; question: string }
  | { kind: 'trigger'; system: SystemManifest; inputs: Record<string, string> };

interface GatheringState {
  system: SystemManifest;
  collectedInputs: Record<string, string>;
  remainingInputs: string[];
  lastActivityAt: number;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export class RouterError extends Error {
  constructor(
    message: string,
    public readonly step?: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'RouterError';
  }
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Confidence above which we proceed without clarification. */
const HIGH_CONFIDENCE_THRESHOLD = 0.75;

/** Session timeout for input gathering (5 minutes). */
const GATHERING_TIMEOUT_MS = 5 * 60 * 1000;

// -----------------------------------------------------------------------------
// Direct Answer via LLM (isolated for test mocking)
// -----------------------------------------------------------------------------

const DIRECT_ANSWER_SYSTEM_PROMPT = `You are a helpful assistant embedded in an AI agent orchestration platform called AUTOPILATE.
The user's message does not match any deployed system. Answer their question directly and concisely.
If you cannot help, say so politely and suggest they check available systems.`;

export async function generateDirectAnswer(message: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: message },
  ];

  // ROUTER pool model is configured via ROUTER_MODEL env var (default: haiku)
  const response = await smartGenerate(
    'ROUTER',
    DIRECT_ANSWER_SYSTEM_PROMPT,
    messages
  );

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

// -----------------------------------------------------------------------------
// Input Extraction via LLM (isolated for test mocking)
// -----------------------------------------------------------------------------

export async function extractInputsFromMessage(
  message: string,
  system: SystemManifest,
  alreadyCollected: Record<string, string>
): Promise<Record<string, string>> {
  const prompt = [
    `The user sent this message in the context of triggering the "${system.name}" system.`,
    `Already collected inputs: ${JSON.stringify(alreadyCollected)}`,
    `Still needed inputs: ${JSON.stringify(
      system.requiredInputs
        .filter((i) => i.required && !alreadyCollected[i.name])
        .map((i) => ({ name: i.name, type: i.type, description: i.description }))
    )}`,
    '',
    `USER MESSAGE: ${message}`,
    '',
    'Extract any input values the user provided. Return ONLY valid JSON mapping input names to extracted string values.',
    'If the message does not contain a value for an input, omit it from the JSON.',
    'Example: {"topic": "machine learning", "format": "blog post"}',
  ].join('\n');

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: prompt },
  ];

  const response = await smartGenerate(
    'ROUTER',
    'You extract structured inputs from natural language. Return ONLY valid JSON, no markdown fences.',
    messages
  );

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const stripped = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  try {
    return JSON.parse(stripped) as Record<string, string>;
  } catch {
    return {};
  }
}

// -----------------------------------------------------------------------------
// Router Agent Class
// -----------------------------------------------------------------------------

export interface RouterAgentOptions {
  /**
   * When true, suppresses Socket.io side effects (emitState, emitLog,
   * emitRouterMessage). Useful for headless callers that only need the
   * RouterDecision return value.
   */
  silent?: boolean;
  /**
   * When set, the router only considers deployed systems with this domain
   * (plus global systems with domain=NULL). Used by the Slack bot to scope
   * each channel's supervisor to its own domain.
   */
  domain?: string;
}

export class RouterAgent {
  private gatheringState: GatheringState | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private onTimeout: ((sessionId: string) => void) | null = null;
  private readonly silent: boolean;
  private readonly domain: string | undefined;

  constructor(
    private readonly sessionId: string,
    options?: RouterAgentOptions
  ) {
    this.silent = options?.silent ?? false;
    this.domain = options?.domain;
  }

  /**
   * Register a callback invoked when a gathering session times out.
   * Used by the Slack bot to send a timeout message back to the user.
   */
  setTimeoutCallback(cb: (sessionId: string) => void): void {
    this.onTimeout = cb;
  }

  /**
   * Process an inbound message. Returns the routing decision taken.
   * Emits socket events as side effects for real-time UI updates.
   */
  async handleMessage(message: string): Promise<RouterDecision> {
    this.emitState('routing');
    this.emitLog(`[Router] Received message: "${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"`);

    // If we're in the middle of gathering inputs for a system, continue that flow
    if (this.gatheringState) {
      // Check for timeout before processing
      if (this.isGatheringTimedOut()) {
        this.clearGatheringState();
        this.emitLog('[Router] Gathering session timed out. Starting fresh classification.');
      } else {
        this.resetTimeout();
        return this.handleGatheringResponse(message);
      }
    }

    // Fetch deployed systems and match
    const deployedSystems = await this.fetchDeployedManifests();
    const matchResult = await matchSystem(message, deployedSystems);

    return this.routeFromMatch(message, matchResult);
  }

  /** Reset any in-progress input gathering. */
  resetGatheringState(): void {
    this.clearGatheringState();
  }

  /** Check if the router is currently gathering inputs for a system. */
  isGathering(): boolean {
    return this.gatheringState !== null;
  }

  /** Clean up timers — call when disposing the agent. */
  destroy(): void {
    this.clearTimeout();
  }

  // ---------------------------------------------------------------------------
  // Private: Timeout Management
  // ---------------------------------------------------------------------------

  private isGatheringTimedOut(): boolean {
    if (!this.gatheringState) return false;
    return Date.now() - this.gatheringState.lastActivityAt > GATHERING_TIMEOUT_MS;
  }

  private startTimeout(): void {
    this.clearTimeout();
    this.timeoutTimer = setTimeout(() => {
      if (this.gatheringState) {
        this.emitLog('[Router] Input gathering timed out after 5 minutes of inactivity.');
        const timeoutMsg = 'Session timed out due to inactivity. Please start your request over.';
        this.emitRouterMessage(timeoutMsg);
        this.gatheringState = null;
        this.emitState('idle');

        if (this.onTimeout) {
          this.onTimeout(this.sessionId);
        }
      }
    }, GATHERING_TIMEOUT_MS);
  }

  private resetTimeout(): void {
    if (this.gatheringState) {
      this.gatheringState.lastActivityAt = Date.now();
    }
    this.startTimeout();
  }

  private clearTimeout(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private clearGatheringState(): void {
    this.gatheringState = null;
    this.clearTimeout();
  }

  // ---------------------------------------------------------------------------
  // Private: Routing Logic
  // ---------------------------------------------------------------------------

  private async routeFromMatch(
    message: string,
    matchResult: SystemMatchResult
  ): Promise<RouterDecision> {
    // No match → direct answer
    if (!matchResult.system) {
      this.emitLog('[Router] No system match. Generating direct answer.');
      const response = await generateDirectAnswer(message);
      const decision: RouterDecision = { kind: 'direct-answer', response };
      this.emitRouterMessage(response);
      this.emitState('idle');
      return decision;
    }

    const { system, missingInputs } = matchResult;
    const requiredMissing = missingInputs.filter((name) =>
      system.requiredInputs.some((i) => i.name === name && i.required)
    );

    // High confidence + all required inputs present → trigger
    if (matchResult.confidence >= HIGH_CONFIDENCE_THRESHOLD && requiredMissing.length === 0) {
      this.emitLog(`[Router] Matched "${system.name}" (confidence: ${matchResult.confidence.toFixed(2)}). Triggering.`);
      const rawInputs = await extractInputsFromMessage(message, system, {});
      const validation = validateExtractedInputs(rawInputs, system.requiredInputs);

      if (!validation.valid) {
        this.emitLog(`[Router] Input validation failed: ${validation.errors.join('; ')}`);
        const question = this.buildClarifyQuestion(system, validation.errors.map((e) => {
          const match = e.match(/input[:\s]+"?(\w+)"?/i) ?? e.match(/input:\s*(\w+)/);
          return match ? match[1] : e;
        }));
        const decision: RouterDecision = {
          kind: 'clarify',
          system,
          missingInputs: validation.errors,
          question,
        };
        this.emitRouterMessage(question);
        this.emitState('idle');
        return decision;
      }

      const decision: RouterDecision = { kind: 'trigger', system, inputs: validation.validatedInputs };
      this.emitRouterMessage(`Triggering system: **${system.name}**`);
      this.emitState('idle');
      return decision;
    }

    // Match found but missing inputs → enter clarify / gathering mode
    this.emitLog(
      `[Router] Matched "${system.name}" (confidence: ${matchResult.confidence.toFixed(2)}) but missing inputs: ${requiredMissing.join(', ')}`
    );

    // Collect any inputs already present in the message
    const rawPartialInputs = await extractInputsFromMessage(message, system, {});
    const partialValidation = validateExtractedInputs(rawPartialInputs, system.requiredInputs);

    // Use validated inputs even if not all required are present (gathering mode)
    const partialInputs = partialValidation.valid
      ? partialValidation.validatedInputs
      : filterValidKeys(rawPartialInputs, system.requiredInputs);
    const stillMissing = requiredMissing.filter((name) => !partialInputs[name]);

    if (stillMissing.length === 0 && partialValidation.valid) {
      // LLM found all inputs on second pass and they're valid
      this.emitLog(`[Router] All inputs extracted on re-analysis. Triggering "${system.name}".`);
      const decision: RouterDecision = { kind: 'trigger', system, inputs: partialValidation.validatedInputs };
      this.emitRouterMessage(`Triggering system: **${system.name}**`);
      this.emitState('idle');
      return decision;
    }

    // Enter gathering mode with timeout tracking
    this.gatheringState = {
      system,
      collectedInputs: partialInputs,
      remainingInputs: stillMissing,
      lastActivityAt: Date.now(),
    };
    this.startTimeout();

    const question = this.buildClarifyQuestion(system, stillMissing);
    const decision: RouterDecision = {
      kind: 'clarify',
      system,
      missingInputs: stillMissing,
      question,
    };
    this.emitRouterMessage(question);
    this.emitState('idle');
    return decision;
  }

  private async handleGatheringResponse(message: string): Promise<RouterDecision> {
    const state = this.gatheringState!;

    const rawExtracted = await extractInputsFromMessage(
      message,
      state.system,
      state.collectedInputs
    );

    // Merge only keys that match declared inputs (strip hallucinated)
    const cleanExtracted = filterValidKeys(rawExtracted, state.system.requiredInputs);
    Object.assign(state.collectedInputs, cleanExtracted);
    state.remainingInputs = state.remainingInputs.filter(
      (name) => !state.collectedInputs[name]
    );

    if (state.remainingInputs.length === 0) {
      // All inputs gathered — validate before triggering
      const validation = validateExtractedInputs(state.collectedInputs, state.system.requiredInputs);
      if (!validation.valid) {
        this.emitLog(`[Router] Gathered inputs failed validation: ${validation.errors.join('; ')}`);
        const question = `Some inputs need correction:\n${validation.errors.map((e) => `- ${e}`).join('\n')}\n\nPlease provide corrected values.`;
        const decision: RouterDecision = {
          kind: 'clarify',
          system: state.system,
          missingInputs: validation.errors,
          question,
        };
        this.emitRouterMessage(question);
        this.emitState('idle');
        return decision;
      }

      this.emitLog(`[Router] All inputs collected for "${state.system.name}". Triggering.`);
      const decision: RouterDecision = {
        kind: 'trigger',
        system: state.system,
        inputs: validation.validatedInputs,
      };
      this.emitRouterMessage(`Triggering system: **${state.system.name}**`);
      this.clearGatheringState();
      this.emitState('idle');
      return decision;
    }

    // Still missing some — ask again
    const question = this.buildClarifyQuestion(state.system, state.remainingInputs);
    const decision: RouterDecision = {
      kind: 'clarify',
      system: state.system,
      missingInputs: state.remainingInputs,
      question,
    };
    this.emitRouterMessage(question);
    this.emitState('idle');
    return decision;
  }

  // ---------------------------------------------------------------------------
  // Private: Helpers
  // ---------------------------------------------------------------------------

  private async fetchDeployedManifests(): Promise<SystemManifest[]> {
    try {
      const records: DeploymentRecord[] = await listSystems(this.domain);
      return records
        .filter((r) => r.status === 'deployed')
        .map((r) => r.manifestJson);
    } catch (err) {
      throw new RouterError('Failed to fetch deployed systems', 'fetch-manifests', err);
    }
  }

  private buildClarifyQuestion(system: SystemManifest, missing: string[]): string {
    const inputDescriptions = missing.map((name) => {
      const input = system.requiredInputs.find((i) => i.name === name);
      return input
        ? `- **${input.name}** (${input.type}): ${input.description}`
        : `- **${name}**`;
    });

    return [
      `I can run **${system.name}** for you, but I need a bit more info:`,
      '',
      ...inputDescriptions,
      '',
      'Please provide the missing details.',
    ].join('\n');
  }

  private emitState(state: 'routing' | 'idle'): void {
    if (this.silent) return;
    emitSessionStateChange({ sessionId: this.sessionId, state });
  }

  private emitRouterMessage(content: string): void {
    if (this.silent) return;
    emitSessionMessage({
      sessionId: this.sessionId,
      message: {
        id: `router-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'system',
        content,
        timestamp: Date.now(),
        metadata: { intent: 'router' },
      },
    });
  }

  private emitLog(output: string): void {
    if (this.silent) return;
    emitExecutionLog(this.sessionId, output, 'stdout', 'workflow');
  }
}

// -----------------------------------------------------------------------------
// Helpers (module-level)
// -----------------------------------------------------------------------------

/** Keep only keys that match a declared input name. */
function filterValidKeys(
  extracted: Record<string, string>,
  requiredInputs: { name: string }[]
): Record<string, string> {
  const declaredNames = new Set(requiredInputs.map((i) => i.name));
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(extracted)) {
    if (declaredNames.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

export function createRouterAgent(
  sessionId: string,
  options?: RouterAgentOptions
): RouterAgent {
  return new RouterAgent(sessionId, options);
}

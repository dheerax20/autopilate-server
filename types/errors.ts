// =============================================================================
// Typed Error Classes for Agent System
// =============================================================================

/**
 * Base error for all agent-related failures.
 */
export class AgentError extends Error {
  constructor(
    public readonly agent: 'supervisor' | 'architect' | 'builder',
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

/**
 * Error when intent classification fails.
 */
export class IntentClassificationError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super('supervisor', message, cause);
    this.name = 'IntentClassificationError';
  }
}

/**
 * Error when plan generation fails.
 */
export class PlanGenerationError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super('architect', message, cause);
    this.name = 'PlanGenerationError';
  }
}

/**
 * Error when plan execution fails.
 */
export class PlanExecutionError extends AgentError {
  constructor(
    message: string,
    public readonly stepId?: string,
    cause?: unknown
  ) {
    super('builder', message, cause);
    this.name = 'PlanExecutionError';
  }
}

/**
 * Error when an LLM API call fails after all retries.
 */
export class LLMApiError extends Error {
  constructor(
    public readonly provider: 'anthropic' | 'google',
    message: string,
    public readonly statusCode?: number,
    cause?: unknown
  ) {
    super(message);
    this.name = 'LLMApiError';
  }
}

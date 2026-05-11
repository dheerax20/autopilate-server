import { describe, it, expect } from 'vitest';
import {
  AgentError,
  IntentClassificationError,
  PlanGenerationError,
  PlanExecutionError,
  LLMApiError,
} from './errors';

describe('Typed Error Classes', () => {
  describe('AgentError', () => {
    it('should store agent name and message', () => {
      const err = new AgentError('supervisor', 'something failed');
      expect(err.agent).toBe('supervisor');
      expect(err.message).toBe('something failed');
      expect(err.name).toBe('AgentError');
      expect(err).toBeInstanceOf(Error);
    });

    it('should store optional cause', () => {
      const cause = new Error('root cause');
      const err = new AgentError('builder', 'wrapped', cause);
      expect(err.cause).toBe(cause);
    });
  });

  describe('IntentClassificationError', () => {
    it('should be an AgentError from supervisor', () => {
      const err = new IntentClassificationError('bad intent');
      expect(err.agent).toBe('supervisor');
      expect(err.name).toBe('IntentClassificationError');
      expect(err).toBeInstanceOf(AgentError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('PlanGenerationError', () => {
    it('should be an AgentError from architect', () => {
      const err = new PlanGenerationError('plan failed');
      expect(err.agent).toBe('architect');
      expect(err.name).toBe('PlanGenerationError');
      expect(err).toBeInstanceOf(AgentError);
    });
  });

  describe('PlanExecutionError', () => {
    it('should be an AgentError from builder with optional stepId', () => {
      const err = new PlanExecutionError('step failed', 'step-3');
      expect(err.agent).toBe('builder');
      expect(err.stepId).toBe('step-3');
      expect(err.name).toBe('PlanExecutionError');
      expect(err).toBeInstanceOf(AgentError);
    });

    it('should work without stepId', () => {
      const err = new PlanExecutionError('general failure');
      expect(err.stepId).toBeUndefined();
    });
  });

  describe('LLMApiError', () => {
    it('should store provider and optional statusCode', () => {
      const err = new LLMApiError('anthropic', 'rate limited', 429);
      expect(err.provider).toBe('anthropic');
      expect(err.statusCode).toBe(429);
      expect(err.name).toBe('LLMApiError');
      expect(err).toBeInstanceOf(Error);
    });

    it('should work for google provider', () => {
      const err = new LLMApiError('google', 'quota exceeded');
      expect(err.provider).toBe('google');
      expect(err.statusCode).toBeUndefined();
    });
  });
});

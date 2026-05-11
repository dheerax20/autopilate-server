import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  webDesignManifest,
  contentFactoryManifest,
  allMockManifests,
} from '../fixtures/mock-system-manifests';
import type { SystemMatchResult } from '../../services/system-matcher';

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

const mockMatchSystem = vi.fn();
vi.mock('../../services/system-matcher', () => ({
  matchSystem: (...args: unknown[]) => mockMatchSystem(...args),
}));

const mockSmartGenerate = vi.fn();
vi.mock('../../lib/anthropic-client', () => ({
  smartGenerate: (...args: unknown[]) => mockSmartGenerate(...args),
}));

const mockListSystems = vi.fn();
vi.mock('../../services/registry', () => ({
  listSystems: (...args: unknown[]) => mockListSystems(...args),
}));

vi.mock('../../socket/emitter', () => ({
  emitSessionStateChange: vi.fn(),
  emitSessionMessage: vi.fn(),
  emitExecutionLog: vi.fn(),
}));

import { RouterAgent, createRouterAgent } from '../../services/router-agent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockLlmTextResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

/** Set up listSystems to return deployed manifests. */
function setupDeployedSystems() {
  mockListSystems.mockResolvedValue(
    allMockManifests.map((m) => ({
      id: `id-${m.slug}`,
      systemName: m.name,
      systemSlug: m.slug,
      manifestJson: m,
      status: 'deployed',
    }))
  );
}

describe('Router Agent', () => {
  let router: RouterAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    router = createRouterAgent('test-session-1');
    setupDeployedSystems();
  });

  // -------------------------------------------------------------------------
  // Direct answer path
  // -------------------------------------------------------------------------
  describe('direct answer path', () => {
    it('returns direct-answer when no system matches', async () => {
      mockMatchSystem.mockResolvedValue({
        system: null,
        confidence: 0.05,
        missingInputs: [],
      });

      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('It is currently about 3:00 AM in Tokyo.')
      );

      const decision = await router.handleMessage('what time is it in Tokyo');

      expect(decision.kind).toBe('direct-answer');
      if (decision.kind === 'direct-answer') {
        expect(decision.response).toContain('Tokyo');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Clarify path
  // -------------------------------------------------------------------------
  describe('clarify path', () => {
    it('returns clarify when system matched but missing required inputs', async () => {
      mockMatchSystem.mockResolvedValue({
        system: webDesignManifest,
        confidence: 0.85,
        missingInputs: ['business_name', 'target_audience', 'page_type'],
      });

      // extractInputsFromMessage — returns empty (user gave no specifics)
      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('{}')
      );

      const decision = await router.handleMessage('build me a website');

      expect(decision.kind).toBe('clarify');
      if (decision.kind === 'clarify') {
        expect(decision.system.slug).toBe('web-design-studio');
        expect(decision.missingInputs).toContain('business_name');
        expect(decision.question).toContain('Web Design Studio');
      }
    });

    it('includes formatted input descriptions in the clarify question', async () => {
      mockMatchSystem.mockResolvedValue({
        system: webDesignManifest,
        confidence: 0.80,
        missingInputs: ['target_audience'],
      });

      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('{}')
      );

      const decision = await router.handleMessage('build a landing page for Acme Corp');

      expect(decision.kind).toBe('clarify');
      if (decision.kind === 'clarify') {
        expect(decision.question).toContain('target_audience');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Trigger path
  // -------------------------------------------------------------------------
  describe('trigger path', () => {
    it('returns trigger when system matched with all inputs provided', async () => {
      mockMatchSystem.mockResolvedValue({
        system: contentFactoryManifest,
        confidence: 0.92,
        missingInputs: [],
      });

      // extractInputsFromMessage returns extracted values
      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse(JSON.stringify({
          topic: 'AI trends in 2026',
          format: 'blog post',
        }))
      );

      const decision = await router.handleMessage(
        'write a blog post about AI trends in 2026'
      );

      expect(decision.kind).toBe('trigger');
      if (decision.kind === 'trigger') {
        expect(decision.system.slug).toBe('content-factory');
        expect(decision.inputs.topic).toBe('AI trends in 2026');
        expect(decision.inputs.format).toBe('blog post');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Multi-turn gathering
  // -------------------------------------------------------------------------
  describe('multi-turn input gathering', () => {
    it('enters gathering mode then completes on second message', async () => {
      // First message: system matched but missing inputs
      mockMatchSystem.mockResolvedValue({
        system: webDesignManifest,
        confidence: 0.85,
        missingInputs: ['business_name', 'target_audience', 'page_type'],
      });

      // extractInputsFromMessage for first message — partial extraction
      mockSmartGenerate.mockResolvedValueOnce(
        mockLlmTextResponse('{}')
      );

      const first = await router.handleMessage('build me a website');
      expect(first.kind).toBe('clarify');
      expect(router.isGathering()).toBe(true);

      // Second message: user provides all missing inputs
      mockSmartGenerate.mockResolvedValueOnce(
        mockLlmTextResponse(JSON.stringify({
          business_name: 'Acme Corp',
          target_audience: 'small business owners',
          page_type: 'landing',
        }))
      );

      const second = await router.handleMessage(
        'It\'s called Acme Corp, targeting small business owners, I need a landing page'
      );

      expect(second.kind).toBe('trigger');
      if (second.kind === 'trigger') {
        expect(second.inputs.business_name).toBe('Acme Corp');
        expect(second.inputs.target_audience).toBe('small business owners');
        expect(second.inputs.page_type).toBe('landing');
      }
      expect(router.isGathering()).toBe(false);
    });

    it('stays in gathering mode when only some inputs provided', async () => {
      mockMatchSystem.mockResolvedValue({
        system: webDesignManifest,
        confidence: 0.85,
        missingInputs: ['business_name', 'target_audience', 'page_type'],
      });

      // First message — no inputs extracted
      mockSmartGenerate.mockResolvedValueOnce(
        mockLlmTextResponse('{}')
      );

      const first = await router.handleMessage('build me a website');
      expect(first.kind).toBe('clarify');

      // Second message — only one input extracted
      mockSmartGenerate.mockResolvedValueOnce(
        mockLlmTextResponse(JSON.stringify({ business_name: 'Acme Corp' }))
      );

      const second = await router.handleMessage('It\'s called Acme Corp');
      expect(second.kind).toBe('clarify');
      if (second.kind === 'clarify') {
        expect(second.missingInputs).not.toContain('business_name');
        expect(second.missingInputs).toContain('target_audience');
        expect(second.missingInputs).toContain('page_type');
      }
      expect(router.isGathering()).toBe(true);
    });

    it('resetGatheringState clears gathering mode', async () => {
      mockMatchSystem.mockResolvedValue({
        system: webDesignManifest,
        confidence: 0.85,
        missingInputs: ['business_name'],
      });
      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('{}')
      );

      await router.handleMessage('build a site');
      expect(router.isGathering()).toBe(true);

      router.resetGatheringState();
      expect(router.isGathering()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Factory
  // -------------------------------------------------------------------------
  describe('createRouterAgent', () => {
    it('creates a RouterAgent instance', () => {
      const agent = createRouterAgent('session-abc');
      expect(agent).toBeInstanceOf(RouterAgent);
      expect(agent.isGathering()).toBe(false);
    });
  });
});

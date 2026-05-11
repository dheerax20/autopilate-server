import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  webDesignManifest,
  contentFactoryManifest,
  seoAuditManifest,
} from '../fixtures/mock-system-manifests';
import type { SystemManifest } from '../../types/registry';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing modules under test
// ---------------------------------------------------------------------------

const mockClassifyMessage = vi.fn();
vi.mock('../../services/system-matcher', () => ({
  matchSystem: async (message: string, manifests: SystemManifest[]) => {
    const classification = await mockClassifyMessage(message, manifests);
    if (!classification.matchedSlug || classification.confidence < 0.4) {
      return { system: null, confidence: classification.confidence, missingInputs: [] };
    }
    const matched = manifests.find((m) => m.slug === classification.matchedSlug);
    if (!matched) return { system: null, confidence: 0, missingInputs: [] };
    return {
      system: matched,
      confidence: classification.confidence,
      missingInputs: classification.missingInputs,
    };
  },
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

/** Register 3 test systems as deployed. */
function registerThreeSystems() {
  const manifests = [webDesignManifest, contentFactoryManifest, seoAuditManifest];
  mockListSystems.mockResolvedValue(
    manifests.map((m) => ({
      id: `id-${m.slug}`,
      systemName: m.name,
      systemSlug: m.slug,
      manifestJson: m,
      status: 'deployed',
    }))
  );
  return manifests;
}

// ---------------------------------------------------------------------------
// Integration: Router Classification Pipeline
// ---------------------------------------------------------------------------

describe('Integration: Router Classification Pipeline', () => {
  let router: RouterAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    router = createRouterAgent('test-session-classify');
    registerThreeSystems();
  });

  // -------------------------------------------------------------------------
  // Scenario 1: "build a landing page" → matches web design system
  // -------------------------------------------------------------------------
  describe('web design request → trigger or clarify', () => {
    it('matches web-design-studio with high confidence and requests missing inputs', async () => {
      mockClassifyMessage.mockResolvedValue({
        matchedSlug: 'web-design-studio',
        confidence: 0.92,
        missingInputs: ['business_name', 'target_audience', 'page_type'],
        reasoning: 'User wants to build a landing page — clear web design task',
      });

      // extractInputsFromMessage — no specifics given
      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('{}')
      );

      const decision = await router.handleMessage('build a landing page');

      expect(decision.kind).toBe('clarify');
      if (decision.kind === 'clarify') {
        expect(decision.system.slug).toBe('web-design-studio');
        expect(decision.missingInputs).toContain('business_name');
        expect(decision.missingInputs).toContain('target_audience');
        expect(decision.missingInputs).toContain('page_type');
        expect(decision.question).toContain('Web Design Studio');
      }
    });

    it('triggers web-design-studio when all inputs are provided', async () => {
      mockClassifyMessage.mockResolvedValue({
        matchedSlug: 'web-design-studio',
        confidence: 0.95,
        missingInputs: [],
        reasoning: 'All inputs provided for web design',
      });

      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse(JSON.stringify({
          business_name: 'Acme Corp',
          target_audience: 'small business owners',
          page_type: 'landing',
        }))
      );

      const decision = await router.handleMessage(
        'build a landing page for Acme Corp targeting small business owners'
      );

      expect(decision.kind).toBe('trigger');
      if (decision.kind === 'trigger') {
        expect(decision.system.slug).toBe('web-design-studio');
        expect(decision.inputs.business_name).toBe('Acme Corp');
        expect(decision.inputs.target_audience).toBe('small business owners');
        expect(decision.inputs.page_type).toBe('landing');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: "what time is it" → no system match, direct answer
  // -------------------------------------------------------------------------
  describe('general question → direct answer', () => {
    it('returns direct-answer when message does not match any system', async () => {
      mockClassifyMessage.mockResolvedValue({
        matchedSlug: null,
        confidence: 0.05,
        missingInputs: [],
        reasoning: 'Generic question, not related to any deployed system',
      });

      // generateDirectAnswer → LLM responds with a direct answer
      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('The current time depends on your timezone. I\'m an AI orchestration platform and don\'t have access to a clock.')
      );

      const decision = await router.handleMessage('what time is it');

      expect(decision.kind).toBe('direct-answer');
      if (decision.kind === 'direct-answer') {
        expect(decision.response.length).toBeGreaterThan(0);
      }

      // Should not have tried to extract inputs
      expect(mockSmartGenerate).toHaveBeenCalledTimes(1); // only for direct answer
    });

    it('returns direct-answer for low-confidence matches', async () => {
      mockClassifyMessage.mockResolvedValue({
        matchedSlug: 'content-factory',
        confidence: 0.2,
        missingInputs: ['topic'],
        reasoning: 'Very vague — could be content but too uncertain',
      });

      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('Could you clarify what you need? I have several systems available.')
      );

      const decision = await router.handleMessage('help me with something');

      // Low confidence (< 0.4 threshold) → treated as no match → direct answer
      expect(decision.kind).toBe('direct-answer');
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: "build me a website" → clarify with missing inputs
  // -------------------------------------------------------------------------
  describe('ambiguous request → clarify flow', () => {
    it('enters clarify mode when matched but missing required inputs', async () => {
      mockClassifyMessage.mockResolvedValue({
        matchedSlug: 'web-design-studio',
        confidence: 0.85,
        missingInputs: ['business_name', 'target_audience', 'page_type'],
        reasoning: 'Wants a website but no specifics given',
      });

      // extractInputsFromMessage — finds nothing
      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('{}')
      );

      const decision = await router.handleMessage('build me a website');

      expect(decision.kind).toBe('clarify');
      if (decision.kind === 'clarify') {
        expect(decision.system.slug).toBe('web-design-studio');
        expect(decision.missingInputs.length).toBeGreaterThan(0);
        expect(decision.question).toContain('need a bit more info');
      }
    });

    it('completes trigger after gathering missing inputs across turns', async () => {
      // Turn 1: match with missing inputs
      mockClassifyMessage.mockResolvedValue({
        matchedSlug: 'web-design-studio',
        confidence: 0.85,
        missingInputs: ['business_name', 'target_audience', 'page_type'],
        reasoning: 'Website request, needs details',
      });

      mockSmartGenerate.mockResolvedValueOnce(
        mockLlmTextResponse('{}')
      );

      const turn1 = await router.handleMessage('build me a website');
      expect(turn1.kind).toBe('clarify');
      expect(router.isGathering()).toBe(true);

      // Turn 2: user provides all missing details
      mockSmartGenerate.mockResolvedValueOnce(
        mockLlmTextResponse(JSON.stringify({
          business_name: 'TechStartup',
          target_audience: 'developers',
          page_type: 'portfolio',
        }))
      );

      const turn2 = await router.handleMessage(
        'TechStartup, targeting developers, portfolio page'
      );

      expect(turn2.kind).toBe('trigger');
      if (turn2.kind === 'trigger') {
        expect(turn2.system.slug).toBe('web-design-studio');
        expect(turn2.inputs.business_name).toBe('TechStartup');
        expect(turn2.inputs.target_audience).toBe('developers');
        expect(turn2.inputs.page_type).toBe('portfolio');
      }
      expect(router.isGathering()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Content Factory matching
  // -------------------------------------------------------------------------
  describe('content request → content factory', () => {
    it('matches content-factory for article writing requests', async () => {
      mockClassifyMessage.mockResolvedValue({
        matchedSlug: 'content-factory',
        confidence: 0.90,
        missingInputs: [],
        reasoning: 'Clear content creation request with topic and format',
      });

      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse(JSON.stringify({
          topic: 'machine learning in healthcare',
          format: 'blog post',
        }))
      );

      const decision = await router.handleMessage(
        'write a blog post about machine learning in healthcare'
      );

      expect(decision.kind).toBe('trigger');
      if (decision.kind === 'trigger') {
        expect(decision.system.slug).toBe('content-factory');
        expect(decision.inputs.topic).toBe('machine learning in healthcare');
        expect(decision.inputs.format).toBe('blog post');
      }
    });
  });

  // -------------------------------------------------------------------------
  // SEO Audit matching
  // -------------------------------------------------------------------------
  describe('audit request → SEO audit agent', () => {
    it('matches seo-audit-agent for website audit requests', async () => {
      mockClassifyMessage.mockResolvedValue({
        matchedSlug: 'seo-audit-agent',
        confidence: 0.88,
        missingInputs: [],
        reasoning: 'User wants SEO audit on a specific URL',
      });

      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse(JSON.stringify({
          url: 'https://example.com',
        }))
      );

      const decision = await router.handleMessage(
        'run an SEO audit on https://example.com'
      );

      expect(decision.kind).toBe('trigger');
      if (decision.kind === 'trigger') {
        expect(decision.system.slug).toBe('seo-audit-agent');
        expect(decision.inputs.url).toBe('https://example.com');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles empty system list gracefully', async () => {
      mockListSystems.mockResolvedValue([]);

      mockClassifyMessage.mockResolvedValue({
        matchedSlug: null,
        confidence: 0,
        missingInputs: [],
        reasoning: 'No systems deployed',
      });

      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('No systems are currently deployed.')
      );

      const decision = await router.handleMessage('build a website');
      expect(decision.kind).toBe('direct-answer');
    });

    it('router reset allows fresh classification after gathering state', async () => {
      // Enter gathering mode
      mockClassifyMessage.mockResolvedValue({
        matchedSlug: 'web-design-studio',
        confidence: 0.85,
        missingInputs: ['business_name'],
        reasoning: 'Website request',
      });

      mockSmartGenerate.mockResolvedValueOnce(mockLlmTextResponse('{}'));

      await router.handleMessage('build a site');
      expect(router.isGathering()).toBe(true);

      // Reset
      router.resetGatheringState();
      expect(router.isGathering()).toBe(false);

      // Now a new message should do fresh classification
      mockClassifyMessage.mockResolvedValue({
        matchedSlug: 'content-factory',
        confidence: 0.90,
        missingInputs: [],
        reasoning: 'Content request',
      });

      mockSmartGenerate.mockResolvedValueOnce(
        mockLlmTextResponse(JSON.stringify({ topic: 'AI', format: 'article' }))
      );

      const decision = await router.handleMessage('write an article about AI');
      expect(decision.kind).toBe('trigger');
      if (decision.kind === 'trigger') {
        expect(decision.system.slug).toBe('content-factory');
      }
    });
  });
});

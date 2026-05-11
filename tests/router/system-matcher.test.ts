import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  allMockManifests,
  webDesignManifest,
  contentFactoryManifest,
} from '../fixtures/mock-system-manifests';

// ---------------------------------------------------------------------------
// Mock the Anthropic client before importing system-matcher
// ---------------------------------------------------------------------------

const mockSmartGenerate = vi.fn();
vi.mock('../../lib/anthropic-client', () => ({
  smartGenerate: (...args: unknown[]) => mockSmartGenerate(...args),
}));

import {
  matchSystem,
  classifyMessage,
  SystemMatchError,
} from '../../services/system-matcher';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock Anthropic response with a single text block. */
function mockLlmResponse(json: Record<string, unknown>) {
  return {
    content: [{ type: 'text', text: JSON.stringify(json) }],
  };
}

describe('System Matcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // classifyMessage — LLM call wrapper
  // -------------------------------------------------------------------------
  describe('classifyMessage', () => {
    it('parses a valid classification response', async () => {
      mockSmartGenerate.mockResolvedValue(
        mockLlmResponse({
          matchedSlug: 'web-design-studio',
          confidence: 0.92,
          missingInputs: ['target_audience'],
          reasoning: 'User wants a landing page',
        })
      );

      const result = await classifyMessage('build a landing page', allMockManifests);

      expect(result.matchedSlug).toBe('web-design-studio');
      expect(result.confidence).toBe(0.92);
      expect(result.missingInputs).toEqual(['target_audience']);
    });

    it('clamps confidence to [0, 1] range', async () => {
      mockSmartGenerate.mockResolvedValue(
        mockLlmResponse({
          matchedSlug: null,
          confidence: 1.5,
          missingInputs: [],
          reasoning: 'over-confident',
        })
      );

      const result = await classifyMessage('anything', allMockManifests);
      expect(result.confidence).toBe(1);
    });

    it('throws SystemMatchError on malformed JSON', async () => {
      mockSmartGenerate.mockResolvedValue({
        content: [{ type: 'text', text: 'not valid json at all' }],
      });

      await expect(classifyMessage('test', allMockManifests)).rejects.toThrow(
        SystemMatchError
      );
    });
  });

  // -------------------------------------------------------------------------
  // matchSystem — Public API
  // -------------------------------------------------------------------------
  describe('matchSystem', () => {
    it('matches "build a landing page for my startup" to web design with high confidence', async () => {
      mockSmartGenerate.mockResolvedValue(
        mockLlmResponse({
          matchedSlug: 'web-design-studio',
          confidence: 0.95,
          missingInputs: ['target_audience'],
          reasoning: 'Clear web design request',
        })
      );

      const result = await matchSystem(
        'build a landing page for my startup',
        allMockManifests
      );

      expect(result.system).not.toBeNull();
      expect(result.system!.slug).toBe('web-design-studio');
      expect(result.confidence).toBe(0.95);
      expect(result.missingInputs).toContain('target_audience');
    });

    it('matches "write a blog post about AI trends" to content factory', async () => {
      mockSmartGenerate.mockResolvedValue(
        mockLlmResponse({
          matchedSlug: 'content-factory',
          confidence: 0.88,
          missingInputs: [],
          reasoning: 'Blog post about AI clearly maps to content factory',
        })
      );

      const result = await matchSystem(
        'write a blog post about AI trends',
        allMockManifests
      );

      expect(result.system).not.toBeNull();
      expect(result.system!.slug).toBe('content-factory');
      expect(result.confidence).toBe(0.88);
    });

    it('returns no match for "what time is it in Tokyo"', async () => {
      mockSmartGenerate.mockResolvedValue(
        mockLlmResponse({
          matchedSlug: null,
          confidence: 0.05,
          missingInputs: [],
          reasoning: 'General knowledge question, no system match',
        })
      );

      const result = await matchSystem(
        'what time is it in Tokyo',
        allMockManifests
      );

      expect(result.system).toBeNull();
      expect(result.confidence).toBe(0.05);
      expect(result.missingInputs).toEqual([]);
    });

    it('matches "build me a website" to web design but flags missing inputs', async () => {
      mockSmartGenerate.mockResolvedValue(
        mockLlmResponse({
          matchedSlug: 'web-design-studio',
          confidence: 0.82,
          missingInputs: ['business_name', 'target_audience', 'page_type'],
          reasoning: 'Wants a website but gave no specifics',
        })
      );

      const result = await matchSystem(
        'build me a website',
        allMockManifests
      );

      expect(result.system).not.toBeNull();
      expect(result.system!.slug).toBe('web-design-studio');
      expect(result.missingInputs).toContain('business_name');
      expect(result.missingInputs).toContain('target_audience');
    });

    it('guards against hallucinated slugs not in manifest list', async () => {
      mockSmartGenerate.mockResolvedValue(
        mockLlmResponse({
          matchedSlug: 'hallucinated-system-that-does-not-exist',
          confidence: 0.90,
          missingInputs: [],
          reasoning: 'LLM hallucinated a non-existent system',
        })
      );

      const result = await matchSystem('do something', allMockManifests);

      // Should discard the hallucinated slug and return no match
      expect(result.system).toBeNull();
      expect(result.confidence).toBe(0);
    });

    it('returns no match when confidence is below threshold (0.4)', async () => {
      mockSmartGenerate.mockResolvedValue(
        mockLlmResponse({
          matchedSlug: 'web-design-studio',
          confidence: 0.2,
          missingInputs: [],
          reasoning: 'Very weak match',
        })
      );

      const result = await matchSystem('maybe something', allMockManifests);

      expect(result.system).toBeNull();
      expect(result.confidence).toBe(0.2);
    });

    it('returns no match when manifests list is empty', async () => {
      const result = await matchSystem('build a website', []);

      expect(result.system).toBeNull();
      expect(result.confidence).toBe(0);
      // Should not even call the LLM
      expect(mockSmartGenerate).not.toHaveBeenCalled();
    });
  });
});

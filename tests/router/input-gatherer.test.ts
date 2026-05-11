import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  webDesignManifest,
  contentFactoryManifest,
} from '../fixtures/mock-system-manifests';
import type { RequiredInput } from '../../types/registry';

// ---------------------------------------------------------------------------
// Mock the Anthropic client before importing input-gatherer
// ---------------------------------------------------------------------------

const mockSmartGenerate = vi.fn();
vi.mock('../../lib/anthropic-client', () => ({
  smartGenerate: (...args: unknown[]) => mockSmartGenerate(...args),
}));

import {
  generateInputPrompts,
  extractSingleInput,
  gatherInputs,
  InputGathererError,
  type ChannelResponder,
} from '../../services/input-gatherer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockLlmTextResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

/**
 * A message that does NOT trigger the identifyMissingInputs heuristic for
 * any of the web design manifest's required inputs. The heuristic checks
 * if the input name or any of the first 3 description keywords (length > 3)
 * appear in the message. "please help" avoids all of them.
 */
const NEUTRAL_MESSAGE = 'please help';

describe('Input Gatherer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSmartGenerate.mockReset();
  });

  // -------------------------------------------------------------------------
  // generateInputPrompts
  // -------------------------------------------------------------------------
  describe('generateInputPrompts', () => {
    it('generates conversational prompts for missing inputs', async () => {
      const missingInputs: RequiredInput[] = [
        webDesignManifest.requiredInputs[0], // business_name
        webDesignManifest.requiredInputs[1], // target_audience
      ];

      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse(
          JSON.stringify([
            { inputName: 'business_name', prompt: 'What\'s the name of your business?' },
            { inputName: 'target_audience', prompt: 'Who is your target audience?' },
          ])
        )
      );

      const prompts = await generateInputPrompts(webDesignManifest, missingInputs);

      expect(prompts).toHaveLength(2);
      expect(prompts[0].inputName).toBe('business_name');
      expect(prompts[0].prompt).toContain('business');
      expect(prompts[1].inputName).toBe('target_audience');
    });

    it('throws InputGathererError on malformed JSON response', async () => {
      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('this is not json')
      );

      await expect(
        generateInputPrompts(webDesignManifest, webDesignManifest.requiredInputs)
      ).rejects.toThrow(InputGathererError);
    });

    it('throws InputGathererError when response is not an array', async () => {
      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('{"not": "an array"}')
      );

      await expect(
        generateInputPrompts(webDesignManifest, webDesignManifest.requiredInputs)
      ).rejects.toThrow(InputGathererError);
    });
  });

  // -------------------------------------------------------------------------
  // extractSingleInput
  // -------------------------------------------------------------------------
  describe('extractSingleInput', () => {
    it('extracts a value from a conversational response', async () => {
      const inputDef: RequiredInput = {
        name: 'topic',
        type: 'string',
        description: 'The subject or topic to write about',
        required: true,
      };

      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('{"value": "machine learning in healthcare"}')
      );

      const value = await extractSingleInput(
        inputDef,
        'I want to write about machine learning in healthcare'
      );

      expect(value).toBe('machine learning in healthcare');
    });

    it('returns null when the LLM cannot extract a value', async () => {
      const inputDef: RequiredInput = {
        name: 'topic',
        type: 'string',
        description: 'The subject or topic to write about',
        required: true,
      };

      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('{"value": null}')
      );

      const value = await extractSingleInput(inputDef, 'I dunno, something cool');
      expect(value).toBeNull();
    });

    it('returns null on malformed JSON response', async () => {
      const inputDef: RequiredInput = {
        name: 'topic',
        type: 'string',
        description: 'The subject',
        required: true,
      };

      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('broken json {{{')
      );

      const value = await extractSingleInput(inputDef, 'anything');
      expect(value).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // gatherInputs — full conversation loop
  // -------------------------------------------------------------------------
  describe('gatherInputs', () => {
    it('compiles a brief immediately when no inputs are missing', async () => {
      // Use content factory with a message that includes keywords from both required inputs
      const brief = await gatherInputs(
        contentFactoryManifest,
        'write a blog post about topic AI trends in format article style',
        vi.fn() // channel responder should not be called
      );

      expect(brief.systemSlug).toBe('content-factory');
      expect(brief.systemName).toBe('Content Factory');
      expect(brief.collectedAt).toBeGreaterThan(0);
    });

    it('asks for each missing input and compiles a brief', async () => {
      // generateInputPrompts response
      mockSmartGenerate.mockResolvedValueOnce(
        mockLlmTextResponse(
          JSON.stringify([
            { inputName: 'business_name', prompt: 'What\'s your business called?' },
            { inputName: 'target_audience', prompt: 'Who is the website for?' },
            { inputName: 'page_type', prompt: 'What kind of page do you need?' },
          ])
        )
      );

      // extractSingleInput responses for each round
      mockSmartGenerate
        .mockResolvedValueOnce(mockLlmTextResponse('{"value": "Acme Corp"}'))
        .mockResolvedValueOnce(mockLlmTextResponse('{"value": "developers"}'))
        .mockResolvedValueOnce(mockLlmTextResponse('{"value": "landing"}'));

      const responses = ['Acme Corp', 'Developers mainly', 'A landing page'];
      let responseIdx = 0;
      const channelResponder: ChannelResponder = vi.fn().mockImplementation(() => {
        return Promise.resolve(responses[responseIdx++]);
      });

      // NEUTRAL_MESSAGE avoids the identifyMissingInputs heuristic matching
      // description keywords, so all 3 required inputs are identified as missing.
      const brief = await gatherInputs(
        webDesignManifest,
        NEUTRAL_MESSAGE,
        channelResponder
      );

      expect(channelResponder).toHaveBeenCalledTimes(3);
      expect(brief.inputs.business_name).toBe('Acme Corp');
      expect(brief.inputs.target_audience).toBe('developers');
      expect(brief.inputs.page_type).toBe('landing');
      expect(brief.systemSlug).toBe('web-design-studio');
    });

    it('re-asks when extraction returns null', async () => {
      // generateInputPrompts
      mockSmartGenerate.mockResolvedValueOnce(
        mockLlmTextResponse(
          JSON.stringify([
            { inputName: 'business_name', prompt: 'What\'s the business name?' },
            { inputName: 'target_audience', prompt: 'Who is the audience?' },
            { inputName: 'page_type', prompt: 'What page type?' },
          ])
        )
      );

      // extractSingleInput: first attempt returns null, second succeeds, then rest succeed
      mockSmartGenerate
        .mockResolvedValueOnce(mockLlmTextResponse('{"value": null}'))     // round 1: business_name fail
        .mockResolvedValueOnce(mockLlmTextResponse('{"value": "Acme"}'))   // round 2: business_name succeed
        .mockResolvedValueOnce(mockLlmTextResponse('{"value": "devs"}'))   // round 3: target_audience
        .mockResolvedValueOnce(mockLlmTextResponse('{"value": "landing"}')); // round 4: page_type

      let callCount = 0;
      const channelResponder: ChannelResponder = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(`response ${callCount}`);
      });

      const brief = await gatherInputs(
        webDesignManifest,
        NEUTRAL_MESSAGE,
        channelResponder
      );

      // 4 rounds: 1 retry for business_name + 1 for target_audience + 1 for page_type
      expect(channelResponder).toHaveBeenCalledTimes(4);
      expect(brief.inputs.business_name).toBe('Acme');
    });

    it('throws after MAX_GATHER_ROUNDS (10) without completing', async () => {
      // generateInputPrompts
      mockSmartGenerate.mockResolvedValueOnce(
        mockLlmTextResponse(
          JSON.stringify([
            { inputName: 'business_name', prompt: 'What\'s the business name?' },
            { inputName: 'target_audience', prompt: 'Who is the audience?' },
            { inputName: 'page_type', prompt: 'What page type?' },
          ])
        )
      );

      // extractSingleInput always returns null — never succeeds
      mockSmartGenerate.mockResolvedValue(
        mockLlmTextResponse('{"value": null}')
      );

      const channelResponder: ChannelResponder = vi.fn().mockResolvedValue('gibberish');

      await expect(
        gatherInputs(webDesignManifest, NEUTRAL_MESSAGE, channelResponder)
      ).rejects.toThrow(InputGathererError);

      // Should have been called exactly 10 times (the hard cap)
      expect(channelResponder).toHaveBeenCalledTimes(10);
    });
  });
});

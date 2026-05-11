import { describe, it, expect } from 'vitest';
import { validateExtractedInputs } from '../services/input-validator';
import type { RequiredInput } from '../types/registry';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const stringInput = (name: string, required = true): RequiredInput => ({
  name,
  type: 'string',
  description: `A ${name} value`,
  required,
});

const numberInput = (name: string, required = true): RequiredInput => ({
  name,
  type: 'number',
  description: `A numeric ${name}`,
  required,
});

const urlInput = (name: string, required = true): RequiredInput => ({
  name,
  type: 'url',
  description: `A URL for ${name}`,
  required,
});

const emailInput = (name: string, required = true): RequiredInput => ({
  name,
  type: 'email',
  description: `An email for ${name}`,
  required,
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('validateExtractedInputs', () => {
  it('passes valid string inputs through cleanly', () => {
    const inputs = { topic: 'machine learning', format: 'blog post' };
    const schema: RequiredInput[] = [
      stringInput('topic'),
      stringInput('format'),
    ];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.validatedInputs).toEqual({
      topic: 'machine learning',
      format: 'blog post',
    });
  });

  it('returns error for missing required input', () => {
    const inputs = { topic: 'AI' };
    const schema: RequiredInput[] = [
      stringInput('topic'),
      stringInput('format'),
    ];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required input: format');
    expect(result.validatedInputs).toEqual({});
  });

  it('strips extra/hallucinated keys not in schema', () => {
    const inputs = {
      topic: 'AI',
      format: 'blog',
      hallucinated_key: 'should be stripped',
      another_fake: 'also stripped',
    };
    const schema: RequiredInput[] = [
      stringInput('topic'),
      stringInput('format'),
    ];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(true);
    expect(result.validatedInputs).toEqual({ topic: 'AI', format: 'blog' });
    expect(result.validatedInputs).not.toHaveProperty('hallucinated_key');
    expect(result.validatedInputs).not.toHaveProperty('another_fake');
  });

  it('accepts valid number type', () => {
    const inputs = { word_count: '20' };
    const schema: RequiredInput[] = [numberInput('word_count')];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(true);
    expect(result.validatedInputs).toEqual({ word_count: '20' });
  });

  it('rejects non-numeric value for number type', () => {
    const inputs = { word_count: 'about twenty' };
    const schema: RequiredInput[] = [numberInput('word_count')];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid number.*word_count/);
  });

  it('accepts valid URL', () => {
    const inputs = { website: 'https://example.com' };
    const schema: RequiredInput[] = [urlInput('website')];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(true);
    expect(result.validatedInputs).toEqual({ website: 'https://example.com' });
  });

  it('accepts http URL', () => {
    const inputs = { website: 'http://example.com/path?q=1' };
    const schema: RequiredInput[] = [urlInput('website')];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(true);
  });

  it('rejects invalid URL without protocol', () => {
    const inputs = { website: 'not-a-url' };
    const schema: RequiredInput[] = [urlInput('website')];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid URL.*website/);
  });

  it('rejects malformed URL with protocol', () => {
    const inputs = { website: 'https://' };
    const schema: RequiredInput[] = [urlInput('website')];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid URL.*website/);
  });

  it('accepts valid email', () => {
    const inputs = { contact: 'user@example.com' };
    const schema: RequiredInput[] = [emailInput('contact')];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(true);
    expect(result.validatedInputs).toEqual({ contact: 'user@example.com' });
  });

  it('rejects invalid email', () => {
    const inputs = { contact: 'not-an-email' };
    const schema: RequiredInput[] = [emailInput('contact')];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid email.*contact/);
  });

  it('truncates values exceeding 2000 characters', () => {
    const longValue = 'a'.repeat(3000);
    const inputs = { topic: longValue };
    const schema: RequiredInput[] = [stringInput('topic')];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(true);
    expect(result.validatedInputs.topic.length).toBe(2000);
  });

  it('strips control characters from values', () => {
    const inputs = { topic: 'hello\x00world\x07test\x1Fend' };
    const schema: RequiredInput[] = [stringInput('topic')];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(true);
    expect(result.validatedInputs.topic).toBe('helloworldtestend');
  });

  it('preserves normal whitespace (tabs, newlines, spaces)', () => {
    const inputs = { topic: 'hello\tworld\ntest end' };
    const schema: RequiredInput[] = [stringInput('topic')];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(true);
    expect(result.validatedInputs.topic).toBe('hello\tworld\ntest end');
  });

  it('returns errors listing all missing required inputs when extraction is empty', () => {
    const inputs = {};
    const schema: RequiredInput[] = [
      stringInput('topic'),
      stringInput('format'),
      numberInput('word_count'),
    ];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(3);
    expect(result.errors).toContain('Missing required input: topic');
    expect(result.errors).toContain('Missing required input: format');
    expect(result.errors).toContain('Missing required input: word_count');
  });

  it('allows missing optional inputs', () => {
    const inputs = { topic: 'AI' };
    const schema: RequiredInput[] = [
      stringInput('topic', true),
      stringInput('color_scheme', false),
    ];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(true);
    expect(result.validatedInputs).toEqual({ topic: 'AI' });
  });

  it('includes optional inputs when provided', () => {
    const inputs = { topic: 'AI', color_scheme: 'blue' };
    const schema: RequiredInput[] = [
      stringInput('topic', true),
      stringInput('color_scheme', false),
    ];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(true);
    expect(result.validatedInputs).toEqual({ topic: 'AI', color_scheme: 'blue' });
  });

  it('treats whitespace-only values as missing', () => {
    const inputs = { topic: '   ', format: 'blog' };
    const schema: RequiredInput[] = [
      stringInput('topic'),
      stringInput('format'),
    ];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required input: topic');
  });

  it('validates type on optional inputs when provided', () => {
    const inputs = { topic: 'AI', word_count: 'many' };
    const schema: RequiredInput[] = [
      stringInput('topic', true),
      numberInput('word_count', false),
    ];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid number.*word_count/);
  });

  it('handles mixed valid and invalid inputs', () => {
    const inputs = {
      topic: 'AI',
      website: 'not-a-url',
      contact: 'bad-email',
    };
    const schema: RequiredInput[] = [
      stringInput('topic'),
      urlInput('website'),
      emailInput('contact'),
    ];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.some((e) => e.includes('URL'))).toBe(true);
    expect(result.errors.some((e) => e.includes('email'))).toBe(true);
  });

  it('accepts negative numbers', () => {
    const inputs = { offset: '-5' };
    const schema: RequiredInput[] = [numberInput('offset')];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(true);
  });

  it('accepts decimal numbers', () => {
    const inputs = { threshold: '0.75' };
    const schema: RequiredInput[] = [numberInput('threshold')];

    const result = validateExtractedInputs(inputs, schema);

    expect(result.valid).toBe(true);
  });
});

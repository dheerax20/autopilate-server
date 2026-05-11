import { describe, it, expect } from 'vitest';
import {
  componentContentQuerySchema,
  inventorySearchQuerySchema,
  capabilitiesQuerySchema,
  chatBodySchema,
  configureWorkflowBodySchema,
  configureNodeBodySchema,
} from './validation';

describe('componentContentQuerySchema', () => {
  it('accepts valid path', () => {
    const result = componentContentQuerySchema.safeParse({ path: '/some/file.md' });
    expect(result.success).toBe(true);
  });

  it('rejects missing path', () => {
    const result = componentContentQuerySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects empty path', () => {
    const result = componentContentQuerySchema.safeParse({ path: '' });
    expect(result.success).toBe(false);
  });
});

describe('inventorySearchQuerySchema', () => {
  it('accepts empty query (all optional)', () => {
    const result = inventorySearchQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts valid search params', () => {
    const result = inventorySearchQuerySchema.safeParse({
      q: 'agent',
      types: 'AGENT,SKILL',
      limit: '50',
      offset: '10',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(10);
    }
  });

  it('rejects limit over 500', () => {
    const result = inventorySearchQuerySchema.safeParse({ limit: '999' });
    expect(result.success).toBe(false);
  });

  it('rejects negative offset', () => {
    const result = inventorySearchQuerySchema.safeParse({ offset: '-1' });
    expect(result.success).toBe(false);
  });
});

describe('capabilitiesQuerySchema', () => {
  it('accepts valid type', () => {
    const result = capabilitiesQuerySchema.safeParse({ type: 'skill' });
    expect(result.success).toBe(true);
  });

  it('accepts no type', () => {
    const result = capabilitiesQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects invalid type', () => {
    const result = capabilitiesQuerySchema.safeParse({ type: 'invalid' });
    expect(result.success).toBe(false);
  });
});

describe('chatBodySchema', () => {
  it('accepts valid body', () => {
    const result = chatBodySchema.safeParse({
      message: 'Create an agent',
      sessionId: 'abc-123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing message', () => {
    const result = chatBodySchema.safeParse({ sessionId: 'abc-123' });
    expect(result.success).toBe(false);
  });

  it('rejects empty message', () => {
    const result = chatBodySchema.safeParse({ message: '', sessionId: 'abc-123' });
    expect(result.success).toBe(false);
  });

  it('rejects missing sessionId', () => {
    const result = chatBodySchema.safeParse({ message: 'hello' });
    expect(result.success).toBe(false);
  });
});

describe('configureWorkflowBodySchema', () => {
  it('accepts valid nodes and edges arrays', () => {
    const result = configureWorkflowBodySchema.safeParse({
      nodes: [{ id: '1' }],
      edges: [{ id: 'e1', source: '1', target: '2' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing nodes', () => {
    const result = configureWorkflowBodySchema.safeParse({ edges: [] });
    expect(result.success).toBe(false);
  });
});

describe('configureNodeBodySchema', () => {
  it('accepts valid node object', () => {
    const result = configureNodeBodySchema.safeParse({
      node: { id: '1', type: 'AGENT' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts node with workflowContext', () => {
    const result = configureNodeBodySchema.safeParse({
      node: { id: '1' },
      workflowContext: {
        nodeCount: 3,
        edgeCount: 2,
        connectedNodes: [],
        workflowName: 'Test',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing node', () => {
    const result = configureNodeBodySchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

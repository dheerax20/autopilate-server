import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// =============================================================================
// MCP Integration Tests
// Tests for sandbox-mcp.ts and canvas-mcp.ts
// =============================================================================

// Mock socket emitter
vi.mock('../socket/emitter', () => ({
  emitNodeCreated: vi.fn(),
  emitNodeUpdated: vi.fn(),
  emitNodeDeleted: vi.fn(),
  emitEdgeCreated: vi.fn(),
  emitEdgeDeleted: vi.fn(),
  emitExecutionLog: vi.fn(),
  initSocketEmitter: vi.fn(),
  getSocketServer: vi.fn(),
}));

// Mock fs for sandbox tests
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('file content'),
    unlink: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ size: 100, isDirectory: () => false }),
    access: vi.fn().mockResolvedValue(undefined),
  },
}));

// =============================================================================
// Canvas MCP Tests
// =============================================================================

import {
  canvas_create_node,
  canvas_connect_nodes,
  canvas_update_property,
  canvas_delete_node,
  canvas_get_state,
  canvas_clear,
  canvas_sync_from_client,
  canvasState,
} from './canvas';

import {
  emitNodeCreated,
  emitNodeDeleted,
  emitEdgeCreated,
  emitEdgeDeleted,
} from '../socket/emitter';

describe('Canvas MCP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvasState.nodes.clear();
    canvasState.edges.clear();
  });

  describe('canvas_create_node', () => {
    it('should create a node with normalized type', () => {
      const result = canvas_create_node({
        type: 'agent',
        label: 'Test Agent',
      });

      expect(result.success).toBe(true);
      expect(result.data?.nodeId).toBeDefined();
      expect(canvasState.nodes.size).toBe(1);

      const node = canvasState.nodes.get(result.data!.nodeId);
      expect(node?.type).toBe('AGENT');
      expect(node?.label).toBe('Test Agent');
    });

    it('should normalize hyphenated types', () => {
      const result = canvas_create_node({
        type: 'agent-pool',
        label: 'Pool',
      });

      expect(result.success).toBe(true);
      const node = canvasState.nodes.get(result.data!.nodeId);
      expect(node?.type).toBe('AGENT_POOL');
    });

    it('should reject invalid parent ID', () => {
      const result = canvas_create_node({
        type: 'agent',
        label: 'Child',
        parentId: 'nonexistent-parent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Parent node not found');
    });

    it('should emit node:created event', () => {
      canvas_create_node({ type: 'agent', label: 'Test' });
      expect(emitNodeCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'AGENT',
          label: 'Test',
        })
      );
    });

    it('should enrich agent config with defaults', () => {
      const result = canvas_create_node({
        type: 'agent',
        label: 'Researcher',
        config: { role: 'specialist' },
      });

      expect(result.success).toBe(true);
      const node = canvasState.nodes.get(result.data!.nodeId);
      expect(node?.data.provider).toBe('anthropic');
      expect(node?.data.systemPrompt).toBeDefined();
      expect(typeof node?.data.systemPrompt).toBe('string');
    });
  });

  describe('canvas_connect_nodes', () => {
    let nodeAId: string;
    let nodeBId: string;

    beforeEach(() => {
      const a = canvas_create_node({ type: 'agent', label: 'A' });
      const b = canvas_create_node({ type: 'agent', label: 'B' });
      nodeAId = a.data!.nodeId;
      nodeBId = b.data!.nodeId;
    });

    it('should connect two existing nodes', () => {
      const result = canvas_connect_nodes({
        sourceId: nodeAId,
        targetId: nodeBId,
        edgeType: 'delegation',
      });

      expect(result.success).toBe(true);
      expect(result.data?.edgeId).toBeDefined();
      expect(canvasState.edges.size).toBe(1);
    });

    it('should reject connecting to nonexistent source', () => {
      const result = canvas_connect_nodes({
        sourceId: 'nonexistent',
        targetId: nodeBId,
        edgeType: 'data',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Source node not found');
    });

    it('should reject connecting to nonexistent target', () => {
      const result = canvas_connect_nodes({
        sourceId: nodeAId,
        targetId: 'nonexistent',
        edgeType: 'data',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Target node not found');
    });

    it('should reject duplicate edges', () => {
      canvas_connect_nodes({
        sourceId: nodeAId,
        targetId: nodeBId,
        edgeType: 'data',
      });

      const result = canvas_connect_nodes({
        sourceId: nodeAId,
        targetId: nodeBId,
        edgeType: 'control',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('should emit edge:created event', () => {
      canvas_connect_nodes({
        sourceId: nodeAId,
        targetId: nodeBId,
        edgeType: 'delegation',
      });

      expect(emitEdgeCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: nodeAId,
          targetId: nodeBId,
          edgeType: 'delegation',
        })
      );
    });
  });

  describe('canvas_update_property', () => {
    let nodeId: string;

    beforeEach(() => {
      const result = canvas_create_node({ type: 'agent', label: 'Original' });
      nodeId = result.data!.nodeId;
    });

    it('should update label', () => {
      const result = canvas_update_property({
        nodeId,
        propertyPath: 'label',
        value: 'Updated',
      });

      expect(result.success).toBe(true);
      expect(canvasState.nodes.get(nodeId)?.label).toBe('Updated');
    });

    it('should update nested data property', () => {
      const result = canvas_update_property({
        nodeId,
        propertyPath: 'model',
        value: 'claude-opus-4-20250514',
      });

      expect(result.success).toBe(true);
      expect(canvasState.nodes.get(nodeId)?.data.model).toBe('claude-opus-4-20250514');
    });

    it('should reject update for nonexistent node', () => {
      const result = canvas_update_property({
        nodeId: 'nonexistent',
        propertyPath: 'label',
        value: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Node not found');
    });
  });

  describe('canvas_delete_node', () => {
    it('should delete a node and its edges', () => {
      const a = canvas_create_node({ type: 'agent', label: 'A' });
      const b = canvas_create_node({ type: 'agent', label: 'B' });
      canvas_connect_nodes({
        sourceId: a.data!.nodeId,
        targetId: b.data!.nodeId,
        edgeType: 'data',
      });

      expect(canvasState.nodes.size).toBe(2);
      expect(canvasState.edges.size).toBe(1);

      const result = canvas_delete_node({ nodeId: a.data!.nodeId });

      expect(result.success).toBe(true);
      expect(canvasState.nodes.size).toBe(1);
      expect(canvasState.edges.size).toBe(0);
    });

    it('should reject deleting nonexistent node', () => {
      const result = canvas_delete_node({ nodeId: 'nonexistent' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Node not found');
    });
  });

  describe('canvas_get_state', () => {
    it('should return empty state', () => {
      const result = canvas_get_state();
      expect(result.success).toBe(true);
      expect(result.data?.nodes).toEqual([]);
      expect(result.data?.edges).toEqual([]);
    });

    it('should return nodes and edges', () => {
      const a = canvas_create_node({ type: 'agent', label: 'A' });
      const b = canvas_create_node({ type: 'agent', label: 'B' });
      canvas_connect_nodes({
        sourceId: a.data!.nodeId,
        targetId: b.data!.nodeId,
        edgeType: 'data',
      });

      const result = canvas_get_state();
      expect(result.success).toBe(true);
      expect(result.data?.nodes.length).toBe(2);
      expect(result.data?.edges.length).toBe(1);
    });
  });

  describe('canvas_clear', () => {
    it('should clear all nodes and edges', () => {
      canvas_create_node({ type: 'agent', label: 'A' });
      canvas_create_node({ type: 'agent', label: 'B' });

      expect(canvasState.nodes.size).toBe(2);

      const result = canvas_clear();
      expect(result.success).toBe(true);
      expect(canvasState.nodes.size).toBe(0);
      expect(canvasState.edges.size).toBe(0);
    });
  });

  describe('canvas_sync_from_client', () => {
    it('should replace state from client data', () => {
      // Pre-populate with server-side data
      canvas_create_node({ type: 'agent', label: 'Server Node' });
      expect(canvasState.nodes.size).toBe(1);

      // Sync from client
      canvas_sync_from_client(
        [{ id: 'client-1', type: 'SKILL', label: 'Client Skill', position: { x: 100, y: 200 } }],
        [{ id: 'edge-1', sourceId: 'client-1', targetId: 'client-2' }]
      );

      expect(canvasState.nodes.size).toBe(1);
      expect(canvasState.nodes.get('client-1')?.label).toBe('Client Skill');
      expect(canvasState.edges.size).toBe(1);
    });
  });

  describe('socket event payload contracts', () => {
    it('node:created payload should include nodeId field', () => {
      canvas_create_node({ type: 'agent', label: 'Test' });

      expect(emitNodeCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: expect.any(String),
          type: 'AGENT',
          label: 'Test',
          position: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
        })
      );
    });

    it('edge:created payload should include edgeId and sourceId/targetId', () => {
      const a = canvas_create_node({ type: 'agent', label: 'A' });
      const b = canvas_create_node({ type: 'agent', label: 'B' });
      canvas_connect_nodes({
        sourceId: a.data!.nodeId,
        targetId: b.data!.nodeId,
        edgeType: 'delegation',
      });

      expect(emitEdgeCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          edgeId: expect.any(String),
          sourceId: a.data!.nodeId,
          targetId: b.data!.nodeId,
          edgeType: 'delegation',
        })
      );
    });

    it('node:deleted payload should include nodeId', () => {
      const result = canvas_create_node({ type: 'agent', label: 'ToDelete' });
      canvas_delete_node({ nodeId: result.data!.nodeId });

      expect(emitNodeDeleted).toHaveBeenCalledWith(result.data!.nodeId);
    });
  });
});

// =============================================================================
// Sandbox MCP Path Validation Tests
// =============================================================================

describe('Sandbox MCP - Path Validation', () => {
  // We test the validatePath function indirectly through the public API.
  // The function rejects null bytes and paths outside the sandbox.

  it('sandbox_create_file should reject null bytes in path', async () => {
    const { sandbox_create_file } = await import('./sandbox-mcp');

    const result = await sandbox_create_file({
      path: 'test\0.txt',
      content: 'malicious',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Access denied');
  });

  it('sandbox_create_file should reject path traversal', async () => {
    const { sandbox_create_file } = await import('./sandbox-mcp');

    const result = await sandbox_create_file({
      path: '../../../etc/passwd',
      content: 'malicious',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Access denied');
  });

  it('SANDBOX_TOOLS registry should have all expected tools', async () => {
    const { SANDBOX_TOOLS } = await import('./sandbox-mcp');

    expect(SANDBOX_TOOLS.sandbox_create_file).toBeDefined();
    expect(SANDBOX_TOOLS.sandbox_read_file).toBeDefined();
    expect(SANDBOX_TOOLS.sandbox_list_directory).toBeDefined();
    expect(SANDBOX_TOOLS.sandbox_delete_file).toBeDefined();
    expect(SANDBOX_TOOLS.sandbox_create_directory).toBeDefined();
    expect(SANDBOX_TOOLS.sandbox_file_exists).toBeDefined();
    expect(SANDBOX_TOOLS.sandbox_execute_command).toBeDefined();
  });
});

// =============================================================================
// Canvas MCP Tool Registry Tests
// =============================================================================

describe('Canvas MCP - Tool Registry', () => {
  it('CANVAS_TOOLS should have all expected tools', async () => {
    const { CANVAS_TOOLS } = await import('./canvas');

    expect(CANVAS_TOOLS.canvas_create_node).toBeDefined();
    expect(CANVAS_TOOLS.canvas_connect_nodes).toBeDefined();
    expect(CANVAS_TOOLS.canvas_update_property).toBeDefined();
    expect(CANVAS_TOOLS.canvas_delete_node).toBeDefined();
    expect(CANVAS_TOOLS.canvas_get_state).toBeDefined();
    expect(CANVAS_TOOLS.canvas_clear).toBeDefined();
    expect(CANVAS_TOOLS.canvas_apply_layout).toBeDefined();
  });

  it('canvas_connect_nodes tool should require edgeType', async () => {
    const { CANVAS_TOOLS } = await import('./canvas');
    const params = CANVAS_TOOLS.canvas_connect_nodes.parameters;

    expect(params.required).toContain('edgeType');
  });
});

// =============================================================================
// Canvas MCP - Barrel Export
// Provides tools for AI agents to manipulate the React Flow canvas
// =============================================================================

// Re-export all public types
export type {
  ToolResult,
  CanvasNode,
  CanvasEdge,
  CreateNodeParams,
  CreateNodeResult,
  ConnectNodesParams,
  ConnectNodesResult,
  UpdatePropertyParams,
  DeleteNodeParams,
  CanvasStateResult,
  ApplyLayoutParams,
} from './types';

// Re-export state
export { canvasState } from './state';

// Re-export tool handlers
export {
  canvas_create_node,
  canvas_connect_nodes,
  canvas_update_property,
  canvas_delete_node,
  canvas_get_state,
  canvas_clear,
  canvas_sync_from_client,
} from './tools';

// Re-export layout functions
export { persistLayout, loadPersistedLayout, canvas_apply_layout } from './layout';

// Re-export enrichment (used by builder)
export { enrichNodeConfig, normalizeNodeType } from './enrichment';

// Import tool handlers for the registry
import {
  canvas_create_node,
  canvas_connect_nodes,
  canvas_update_property,
  canvas_delete_node,
  canvas_get_state,
  canvas_clear,
} from './tools';
import { canvas_apply_layout } from './layout';

// -----------------------------------------------------------------------------
// Tool Registry (for Builder agent)
// -----------------------------------------------------------------------------

export const CANVAS_TOOLS = {
  canvas_create_node: {
    name: 'canvas_create_node',
    description: 'Create a new node on the visual canvas',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Node type: agent, skill, department, agent-pool, hook, command, mcp-server',
        },
        label: {
          type: 'string',
          description: 'Display label for the node',
        },
        parentId: {
          type: 'string',
          description: 'Optional parent node ID for nested nodes',
        },
        position: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
          },
          description: 'Optional position coordinates',
        },
        config: {
          type: 'object',
          description: 'Node configuration data',
        },
      },
      required: ['type', 'label'],
    },
    handler: canvas_create_node,
  },

  canvas_connect_nodes: {
    name: 'canvas_connect_nodes',
    description: 'Connect two nodes with a semantic edge. You MUST specify edgeType to define the relationship.',
    parameters: {
      type: 'object',
      properties: {
        sourceId: {
          type: 'string',
          description: 'Source node ID',
        },
        targetId: {
          type: 'string',
          description: 'Target node ID',
        },
        edgeType: {
          type: 'string',
          enum: ['data', 'control', 'event', 'delegation', 'failover'],
          description: 'REQUIRED - Type: delegation (Manager->Worker, orange), data (info flow, blue), control (sequence, green), event (triggers, purple), failover (backup, red dashed)',
        },
      },
      required: ['sourceId', 'targetId', 'edgeType'],
    },
    handler: canvas_connect_nodes,
  },

  canvas_update_property: {
    name: 'canvas_update_property',
    description: 'Update a property on an existing node',
    parameters: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'Node ID to update',
        },
        propertyPath: {
          type: 'string',
          description: 'Dot-notation path to property (e.g., "config.model", "label")',
        },
        value: {
          description: 'New value for the property',
        },
      },
      required: ['nodeId', 'propertyPath', 'value'],
    },
    handler: canvas_update_property,
  },

  canvas_delete_node: {
    name: 'canvas_delete_node',
    description: 'Delete a node and its connected edges',
    parameters: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description: 'Node ID to delete',
        },
      },
      required: ['nodeId'],
    },
    handler: canvas_delete_node,
  },

  canvas_get_state: {
    name: 'canvas_get_state',
    description: 'Get the current state of all nodes and edges on the canvas',
    parameters: {
      type: 'object',
      properties: {},
    },
    handler: canvas_get_state,
  },

  canvas_clear: {
    name: 'canvas_clear',
    description: 'Clear all nodes and edges from the canvas',
    parameters: {
      type: 'object',
      properties: {},
    },
    handler: canvas_clear,
  },

  canvas_apply_layout: {
    name: 'canvas_apply_layout',
    description: 'Apply an auto-layout strategy to organize nodes on the canvas',
    parameters: {
      type: 'object',
      properties: {
        strategy: {
          type: 'string',
          enum: ['grid', 'hierarchical', 'force'],
          description: 'Layout strategy: grid (4-column grid), hierarchical (tree top-down), force (collision-based spacing)',
        },
        spacing: {
          type: 'number',
          description: 'Spacing between nodes in pixels (default: 150)',
        },
      },
      required: ['strategy'],
    },
    handler: canvas_apply_layout,
  },
};

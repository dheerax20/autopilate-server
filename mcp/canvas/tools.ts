// =============================================================================
// Canvas MCP Tool Handlers
// CRUD operations for nodes and edges on the React Flow canvas
// =============================================================================

import { v4 as uuidv4 } from 'uuid';
import {
  emitNodeCreated,
  emitNodeUpdated,
  emitNodeDeleted,
  emitEdgeCreated,
  emitEdgeDeleted,
} from '../../socket/emitter';
import { CanvasNodePayload, CanvasEdgePayload } from '../../shared/socket-events';
import { canvasState } from './state';
import { normalizeNodeType, enrichNodeConfig } from './enrichment';
import { calculateNextPosition, setNestedProperty } from './helpers';
import { persistLayout } from './layout';
import type {
  ToolResult,
  CreateNodeParams,
  CreateNodeResult,
  ConnectNodesParams,
  ConnectNodesResult,
  UpdatePropertyParams,
  DeleteNodeParams,
  CanvasStateResult,
} from './types';

// -----------------------------------------------------------------------------
// Tool: canvas_create_node
// -----------------------------------------------------------------------------

export function canvas_create_node(params: CreateNodeParams): ToolResult<CreateNodeResult> {
  try {
    const nodeId = uuidv4();

    // Calculate position (auto-layout if not specified)
    const position = params.position || calculateNextPosition(params.parentId);

    // Validate parent exists if specified
    if (params.parentId && !canvasState.nodes.has(params.parentId)) {
      return {
        success: false,
        error: `Parent node not found: ${params.parentId}`,
      };
    }

    // Normalize the node type to UPPERCASE_UNDERSCORE format
    const normalizedType = normalizeNodeType(params.type);

    // Phase 7: Comprehensive config enrichment for ALL node types
    // Merges intelligent defaults under the incoming config so agents/hooks/skills
    // are immediately runnable and fully configured in the Properties panel.
    const enrichedConfig = enrichNodeConfig(normalizedType, params.label, params.config || {});
    console.log(`[Canvas] Enriched config for ${normalizedType} "${params.label}" — ${Object.keys(enrichedConfig).length} properties`);

    // Create node in state
    const node = {
      id: nodeId,
      type: normalizedType,
      label: params.label,
      position,
      parentId: params.parentId,
      data: enrichedConfig,
    };

    canvasState.nodes.set(nodeId, node);

    // Emit socket event to update UI
    const payload: CanvasNodePayload = {
      nodeId,
      type: normalizedType,
      label: params.label,
      position,
      parentId: params.parentId,
      data: enrichedConfig,
    };
    emitNodeCreated(payload);

    // Persist layout after mutation
    persistLayout();

    return {
      success: true,
      data: { nodeId, position },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// -----------------------------------------------------------------------------
// Tool: canvas_connect_nodes
// -----------------------------------------------------------------------------

export function canvas_connect_nodes(params: ConnectNodesParams): ToolResult<ConnectNodesResult> {
  try {
    // Validate source and target exist
    if (!canvasState.nodes.has(params.sourceId)) {
      return {
        success: false,
        error: `Source node not found: ${params.sourceId}`,
      };
    }
    if (!canvasState.nodes.has(params.targetId)) {
      return {
        success: false,
        error: `Target node not found: ${params.targetId}`,
      };
    }

    // Check for duplicate edge
    for (const edge of canvasState.edges.values()) {
      if (edge.sourceId === params.sourceId && edge.targetId === params.targetId) {
        return {
          success: false,
          error: `Edge already exists between ${params.sourceId} and ${params.targetId}`,
        };
      }
    }

    const edgeId = uuidv4();

    // Create edge in state
    const edge = {
      id: edgeId,
      sourceId: params.sourceId,
      targetId: params.targetId,
      edgeType: params.edgeType || 'data',
      data: params.data,
    };

    canvasState.edges.set(edgeId, edge);

    // Emit socket event to update UI
    const payload: CanvasEdgePayload = {
      edgeId,
      sourceId: params.sourceId,
      targetId: params.targetId,
      edgeType: params.edgeType,
      data: params.data,
    };
    emitEdgeCreated(payload);

    // Persist layout after mutation
    persistLayout();

    return {
      success: true,
      data: { edgeId },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// -----------------------------------------------------------------------------
// Tool: canvas_update_property
// -----------------------------------------------------------------------------

export function canvas_update_property(params: UpdatePropertyParams): ToolResult<void> {
  try {
    const node = canvasState.nodes.get(params.nodeId);
    if (!node) {
      return {
        success: false,
        error: `Node not found: ${params.nodeId}`,
      };
    }

    // Parse property path and update
    const pathParts = params.propertyPath.split('.');

    if (pathParts[0] === 'label') {
      node.label = String(params.value);
    } else if (pathParts[0] === 'position') {
      if (pathParts[1] === 'x') {
        node.position.x = Number(params.value);
      } else if (pathParts[1] === 'y') {
        node.position.y = Number(params.value);
      } else {
        node.position = params.value as { x: number; y: number };
      }
    } else {
      // Update nested data property
      setNestedProperty(node.data, pathParts, params.value);
    }

    // Emit socket event to update UI
    emitNodeUpdated({
      nodeId: params.nodeId,
      changes: {
        label: pathParts[0] === 'label' ? String(params.value) : undefined,
        position: pathParts[0] === 'position' ? node.position : undefined,
        data: pathParts[0] !== 'label' && pathParts[0] !== 'position' ? node.data : undefined,
      },
    });

    // Persist layout after mutation
    persistLayout();

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// -----------------------------------------------------------------------------
// Tool: canvas_delete_node
// -----------------------------------------------------------------------------

export function canvas_delete_node(params: DeleteNodeParams): ToolResult<void> {
  try {
    if (!canvasState.nodes.has(params.nodeId)) {
      return {
        success: false,
        error: `Node not found: ${params.nodeId}`,
      };
    }

    // Delete node
    canvasState.nodes.delete(params.nodeId);

    // Delete all connected edges
    const edgesToDelete: string[] = [];
    for (const [edgeId, edge] of canvasState.edges) {
      if (edge.sourceId === params.nodeId || edge.targetId === params.nodeId) {
        edgesToDelete.push(edgeId);
      }
    }
    for (const edgeId of edgesToDelete) {
      canvasState.edges.delete(edgeId);
      emitEdgeDeleted(edgeId);
    }

    // Delete child nodes (recursive)
    const childNodes = [...canvasState.nodes.values()].filter(
      (n) => n.parentId === params.nodeId
    );
    for (const child of childNodes) {
      canvas_delete_node({ nodeId: child.id });
    }

    // Emit socket event
    emitNodeDeleted(params.nodeId);

    // Persist layout after mutation
    persistLayout();

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// -----------------------------------------------------------------------------
// Tool: canvas_get_state
// -----------------------------------------------------------------------------

export function canvas_get_state(): ToolResult<CanvasStateResult> {
  try {
    const nodes = [...canvasState.nodes.values()].map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
      position: node.position,
      parentId: node.parentId,
    }));

    const edges = [...canvasState.edges.values()].map((edge) => ({
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      edgeType: edge.edgeType,
    }));

    return {
      success: true,
      data: { nodes, edges },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// -----------------------------------------------------------------------------
// Tool: canvas_clear
// -----------------------------------------------------------------------------

export function canvas_clear(): ToolResult<void> {
  try {
    // Emit delete events for all nodes (which will cascade to edges)
    for (const nodeId of canvasState.nodes.keys()) {
      emitNodeDeleted(nodeId);
    }

    // Clear state
    canvasState.nodes.clear();
    canvasState.edges.clear();

    // Persist empty layout
    persistLayout();

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// -----------------------------------------------------------------------------
// Tool: canvas_sync_from_client
// Sync state from client (when client has manual changes)
// -----------------------------------------------------------------------------

export function canvas_sync_from_client(
  nodes: Array<{ id: string; type: string; label: string; position: { x: number; y: number }; parentId?: string; data?: Record<string, unknown> }>,
  edges: Array<{ id: string; sourceId: string; targetId: string; edgeType?: string; data?: Record<string, unknown> }>
): void {
  canvasState.nodes.clear();
  canvasState.edges.clear();

  for (const node of nodes) {
    canvasState.nodes.set(node.id, {
      id: node.id,
      type: node.type,
      label: node.label,
      position: node.position,
      parentId: node.parentId,
      data: node.data || {},
    });
  }

  for (const edge of edges) {
    canvasState.edges.set(edge.id, {
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      edgeType: edge.edgeType,
      data: edge.data,
    });
  }
}

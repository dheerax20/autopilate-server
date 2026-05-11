// =============================================================================
// Canvas Layout
// Layout algorithms (grid, hierarchical, force) and persistence
// =============================================================================

import fs from 'fs/promises';
import path from 'path';
import {
  emitNodeUpdated,
} from '../../socket/emitter';
import { SANDBOX_ROOT } from '../sandbox-mcp';
import { canvasState } from './state';
import type { CanvasNode, ApplyLayoutParams, ToolResult } from './types';

// Layout file path
const LAYOUT_FILE = path.join(SANDBOX_ROOT, 'layout.json');

// -----------------------------------------------------------------------------
// Layout Persistence
// -----------------------------------------------------------------------------

/**
 * Persist the current canvas layout to sandbox/layout.json
 * Phase 6.3: Exported for socket handler access
 */
export async function persistLayout(): Promise<void> {
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

    // Ensure sandbox directory exists
    await fs.mkdir(SANDBOX_ROOT, { recursive: true });

    await fs.writeFile(
      LAYOUT_FILE,
      JSON.stringify({ nodes, edges }, null, 2),
      'utf-8'
    );
    console.log(`[Canvas] Layout persisted to ${LAYOUT_FILE}`);
  } catch (error) {
    console.error('[Canvas] Failed to persist layout:', error);
  }
}

/**
 * Load persisted layout from sandbox/layout.json on server startup
 */
export async function loadPersistedLayout(): Promise<void> {
  try {
    const content = await fs.readFile(LAYOUT_FILE, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;

    // Validate structure before loading
    if (!parsed || typeof parsed !== 'object') {
      console.warn('[Canvas] Invalid layout file: not an object, starting fresh');
      return;
    }

    const nodes = parsed.nodes;
    const edges = parsed.edges;

    if (!Array.isArray(nodes) || !Array.isArray(edges)) {
      console.warn('[Canvas] Invalid layout file: missing nodes/edges arrays, starting fresh');
      return;
    }

    // Clear existing state
    canvasState.nodes.clear();
    canvasState.edges.clear();

    // Load nodes (skip malformed entries)
    for (const node of nodes) {
      if (!node || typeof node !== 'object' || typeof (node as Record<string, unknown>).id !== 'string') {
        continue;
      }
      const n = node as Record<string, unknown>;
      canvasState.nodes.set(n.id as string, {
        id: n.id as string,
        type: (n.type as string) || 'AGENT',
        label: (n.label as string) || (n.id as string),
        position: (n.position as { x: number; y: number }) || { x: 0, y: 0 },
        parentId: n.parentId as string | undefined,
        data: (n.data as Record<string, unknown>) || {},
      });
    }

    // Load edges (skip malformed entries)
    for (const edge of edges) {
      if (!edge || typeof edge !== 'object' || typeof (edge as Record<string, unknown>).id !== 'string') {
        continue;
      }
      const e = edge as Record<string, unknown>;
      canvasState.edges.set(e.id as string, {
        id: e.id as string,
        sourceId: (e.sourceId as string) || '',
        targetId: (e.targetId as string) || '',
        edgeType: e.edgeType as string | undefined,
        data: e.data as Record<string, unknown> | undefined,
      });
    }

    console.log(`[Canvas] Loaded ${canvasState.nodes.size} nodes, ${canvasState.edges.size} edges from layout.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log('[Canvas] No persisted layout found, starting fresh');
    } else {
      console.error('[Canvas] Failed to load persisted layout:', error);
    }
  }
}

// -----------------------------------------------------------------------------
// Tool: canvas_apply_layout
// -----------------------------------------------------------------------------

export function canvas_apply_layout(params: ApplyLayoutParams): ToolResult<void> {
  try {
    const nodes = [...canvasState.nodes.values()];
    const spacing = params.spacing || 150;

    switch (params.strategy) {
      case 'grid': {
        // Arrange nodes in a grid pattern (4 columns)
        const rootNodes = nodes.filter(n => !n.parentId);
        rootNodes.forEach((node, i) => {
          node.position = {
            x: (i % 4) * spacing + 100,
            y: Math.floor(i / 4) * spacing + 100,
          };
        });

        // Position child nodes relative to parents
        nodes.filter(n => n.parentId).forEach((node) => {
          const parent = canvasState.nodes.get(node.parentId!);
          if (parent) {
            const siblings = nodes.filter(n => n.parentId === node.parentId);
            const siblingIndex = siblings.indexOf(node);
            node.position = {
              x: parent.position.x + 50,
              y: parent.position.y + 80 + siblingIndex * 100,
            };
          }
        });
        break;
      }

      case 'hierarchical': {
        // Top-down tree layout: parents above children
        const rootNodes = nodes.filter(n => !n.parentId);
        const levels: Map<number, CanvasNode[]> = new Map();

        // Build levels
        function assignLevel(node: CanvasNode, level: number): void {
          if (!levels.has(level)) levels.set(level, []);
          levels.get(level)!.push(node);

          const children = nodes.filter(n => n.parentId === node.id);
          children.forEach(child => assignLevel(child, level + 1));
        }

        rootNodes.forEach(root => assignLevel(root, 0));

        // Position by level
        levels.forEach((levelNodes, level) => {
          levelNodes.forEach((node, i) => {
            node.position = {
              x: i * spacing + 100,
              y: level * spacing + 100,
            };
          });
        });
        break;
      }

      case 'force': {
        // Simple collision detection - push overlapping nodes apart
        const iterations = 50;
        const minDistance = spacing * 0.8;

        for (let iter = 0; iter < iterations; iter++) {
          for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
              const nodeA = nodes[i];
              const nodeB = nodes[j];

              const dx = nodeB.position.x - nodeA.position.x;
              const dy = nodeB.position.y - nodeA.position.y;
              const distance = Math.sqrt(dx * dx + dy * dy);

              if (distance < minDistance && distance > 0) {
                const overlap = (minDistance - distance) / 2;
                const nx = dx / distance;
                const ny = dy / distance;

                nodeA.position.x -= nx * overlap;
                nodeA.position.y -= ny * overlap;
                nodeB.position.x += nx * overlap;
                nodeB.position.y += ny * overlap;
              }
            }
          }
        }

        // Ensure all positions are positive
        let minX = Infinity, minY = Infinity;
        nodes.forEach(node => {
          minX = Math.min(minX, node.position.x);
          minY = Math.min(minY, node.position.y);
        });

        if (minX < 50 || minY < 50) {
          const offsetX = minX < 50 ? 100 - minX : 0;
          const offsetY = minY < 50 ? 100 - minY : 0;
          nodes.forEach(node => {
            node.position.x += offsetX;
            node.position.y += offsetY;
          });
        }
        break;
      }
    }

    // Emit updates for all nodes
    nodes.forEach(node => {
      emitNodeUpdated({
        nodeId: node.id,
        changes: { position: node.position },
      });
    });

    // Persist the new layout
    persistLayout();

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// =============================================================================
// Canvas Helper Functions
// =============================================================================

import { canvasState } from './state';

export function calculateNextPosition(parentId?: string): { x: number; y: number } {
  // Phase 5.1 Fix: Grid layout for containers to avoid "Sardine Can" effect
  const existingNodes = [...canvasState.nodes.values()];

  if (parentId) {
    const parent = canvasState.nodes.get(parentId);
    const siblings = existingNodes.filter((n) => n.parentId === parentId);
    const count = siblings.length;

    // Check parent type for layout strategy
    if (parent?.type === 'AGENT_POOL') {
      // GRID LAYOUT: 3 columns for agents inside pools
      const col = count % 3;
      const row = Math.floor(count / 3);
      return { x: 40 + col * 250, y: 80 + row * 150 };
    } else if (parent?.type === 'DEPARTMENT') {
      // HORIZONTAL LAYOUT: Pools side by side inside departments
      return { x: 50 + count * 550, y: 100 };
    }

    // Fallback: vertical stack for other container types
    return {
      x: 50,
      y: 80 + count * 120,
    };
  }

  // Root nodes: grid pattern (4 columns)
  const rootNodes = existingNodes.filter((n) => !n.parentId);
  const col = rootNodes.length % 4;
  const row = Math.floor(rootNodes.length / 4);

  return {
    x: 100 + col * 400,
    y: 100 + row * 300,
  };
}

export function setNestedProperty(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown
): void {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!(key in current) || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

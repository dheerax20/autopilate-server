// =============================================================================
// Canvas State
// In-memory canvas state (per session, to be enhanced later)
// =============================================================================

import type { CanvasNode, CanvasEdge } from './types';

// Phase 6.3: Exported for socket handler access
export const canvasState: {
  nodes: Map<string, CanvasNode>;
  edges: Map<string, CanvasEdge>;
} = {
  nodes: new Map(),
  edges: new Map(),
};

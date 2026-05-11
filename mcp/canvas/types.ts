// =============================================================================
// Canvas MCP Types
// Shared interfaces for canvas state, tool parameters, and results
// =============================================================================

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface CanvasNode {
  id: string;
  type: string;
  label: string;
  position: { x: number; y: number };
  parentId?: string;
  data: Record<string, unknown>;
}

export interface CanvasEdge {
  id: string;
  sourceId: string;
  targetId: string;
  edgeType?: string;
  data?: Record<string, unknown>;
}

export interface CreateNodeParams {
  type: string;           // e.g., 'agent', 'skill', 'department'
  label: string;
  parentId?: string;      // For nested nodes (e.g., agent in department)
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
}

export interface CreateNodeResult {
  nodeId: string;
  position: { x: number; y: number };
}

export interface ConnectNodesParams {
  sourceId: string;
  targetId: string;
  edgeType: string;       // REQUIRED: 'data', 'control', 'event', 'delegation', 'failover'
  data?: Record<string, unknown>;
}

export interface ConnectNodesResult {
  edgeId: string;
}

export interface UpdatePropertyParams {
  nodeId: string;
  propertyPath: string;   // Dot notation: 'config.model' or 'label'
  value: unknown;
}

export interface DeleteNodeParams {
  nodeId: string;
}

export interface CanvasStateResult {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    position: { x: number; y: number };
    parentId?: string;
  }>;
  edges: Array<{
    id: string;
    sourceId: string;
    targetId: string;
    edgeType?: string;
  }>;
}

export interface ApplyLayoutParams {
  strategy: 'grid' | 'hierarchical' | 'force';
  spacing?: number;  // Default 150
}

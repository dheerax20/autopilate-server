// =============================================================================
// Socket.io Event Types (Shared between Server and Client)
// =============================================================================

// -----------------------------------------------------------------------------
// Session Events
// -----------------------------------------------------------------------------

export type SessionState =
  | 'idle'
  | 'routing'      // Supervisor analyzing intent
  | 'planning'     // Architect generating plan
  | 'executing'    // Builder executing steps
  | 'paused'
  | 'completed'
  | 'error';

export interface SessionMessage {
  id: string;
  role: 'user' | 'supervisor' | 'architect' | 'builder' | 'system';
  content: string;
  timestamp: number;
  metadata?: {
    intent?: string;
    planId?: string;
    stepId?: string;
  };
}

export interface SessionStatePayload {
  sessionId: string;
  state: SessionState;
  previousState?: SessionState;
}

export interface SessionMessagePayload {
  sessionId: string;
  message: SessionMessage;
}

// -----------------------------------------------------------------------------
// Canvas Events
// -----------------------------------------------------------------------------

export interface CanvasNodePayload {
  nodeId: string;
  type: string;
  label: string;
  position: { x: number; y: number };
  parentId?: string;
  data?: Record<string, unknown>;
  style?: Record<string, unknown>;  // Optional React Flow node styling (e.g. width, height for containers)
}

export interface CanvasNodeUpdatePayload {
  nodeId: string;
  changes: {
    position?: { x: number; y: number };
    data?: Record<string, unknown>;
    label?: string;
  };
}

export interface CanvasEdgePayload {
  edgeId: string;
  sourceId: string;
  targetId: string;
  edgeType?: string;
  data?: Record<string, unknown>;
}

export interface CanvasEdgeUpdatePayload {
  edgeId: string;
  changes: {
    data?: Record<string, unknown>;
  };
}

// -----------------------------------------------------------------------------
// Execution Events
// -----------------------------------------------------------------------------

export interface ExecutionStepPayload {
  sessionId: string;
  planId: string;
  stepId: string;
  stepName: string;
  stepOrder: number;
  totalSteps: number;
}

export interface ExecutionStepResultPayload extends ExecutionStepPayload {
  success: boolean;
  result?: unknown;
  error?: string;
  createdNodeId?: string;
  createdEdgeId?: string;
}

export interface ExecutionLogPayload {
  sessionId: string;
  output: string;
  stream: 'stdout' | 'stderr';
  timestamp: number;
  source?: 'workflow' | 'fixer';
}

export interface AgentResultPayload {
  sessionId: string;
  phaseIndex: number;
  phaseName: string;
  agentId: string;
  agentLabel: string;
  status: 'success' | 'error' | 'timeout';
  output: string;
  tokensUsed: { input: number; output: number };
  durationMs: number;
  cost: number;
}

export interface ExecutionReportPayload {
  sessionId: string;
  workflow: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  totalCost: number;
  totalTokens: { input: number; output: number };
  phases: Array<{
    name: string;
    results: Array<{
      agentId: string;
      agentLabel: string;
      status: 'success' | 'error' | 'timeout';
      output: string;
      tokensUsed: { input: number; output: number };
      durationMs: number;
      cost: number;
    }>;
    durationMs: number;
  }>;
  status: 'success' | 'partial' | 'failed';
}

// -----------------------------------------------------------------------------
// Metrics Events
// -----------------------------------------------------------------------------

export interface MetricsExecutionStartedPayload {
  systemSlug: string;
  executionId: string;
  startedAt: string;
}

export interface MetricsExecutionCompletedPayload {
  systemSlug: string;
  executionId: string;
  duration: number;
  cost: number;
  status: 'success' | 'partial';
}

export interface MetricsExecutionFailedPayload {
  systemSlug: string;
  executionId: string;
  error: string;
}

export interface MetricsRequestPayload {
  slug?: string;
  hours?: number;
}

export interface MetricsSystemStats {
  totalExecutions: number;
  successCount: number;
  failedCount: number;
  successRate: number;
  avgDurationSeconds: number;
  totalCostUsd: number;
  lastExecution: string | null;
}

export interface MetricsGlobalStats {
  totalExecutions: number;
  successRate: number;
  avgDurationSeconds: number;
  totalCostUsd: number;
  systemBreakdown: Array<{ slug: string; count: number; successRate: number }>;
}

export type MetricsResponsePayload =
  | { type: 'system'; slug: string; stats: MetricsSystemStats }
  | { type: 'global'; stats: MetricsGlobalStats };

// -----------------------------------------------------------------------------
// Server to Client Events
// -----------------------------------------------------------------------------

export interface FixerPatchResult {
  nodeLabel: string;
  fieldsApplied: string[];
  success: boolean;
  error?: string;
}

export interface FixerApplyPatchesResultPayload {
  sessionId: string;
  results: FixerPatchResult[];
  totalApplied: number;
  totalFailed: number;
}

export interface ServerToClientEvents {
  // Session events
  'session:stateChange': (payload: SessionStatePayload) => void;
  'session:message': (payload: SessionMessagePayload) => void;

  // Canvas events
  'node:created': (payload: CanvasNodePayload) => void;
  'node:updated': (payload: CanvasNodeUpdatePayload) => void;
  'node:deleted': (payload: { nodeId: string }) => void;
  'edge:created': (payload: CanvasEdgePayload) => void;
  'edge:deleted': (payload: { edgeId: string }) => void;

  // Execution events
  'execution:stepStart': (payload: ExecutionStepPayload) => void;
  'execution:stepComplete': (payload: ExecutionStepResultPayload) => void;
  'execution:planComplete': (payload: { sessionId: string; planId: string; success: boolean }) => void;
  'execution:log': (payload: ExecutionLogPayload) => void;
  'execution:agentResult': (payload: AgentResultPayload) => void;
  'execution:report': (payload: ExecutionReportPayload) => void;

  // Fixer events
  'fixer:patches-applied': (payload: FixerApplyPatchesResultPayload) => void;

  // Metrics events
  'metrics:execution-started': (payload: MetricsExecutionStartedPayload) => void;
  'metrics:execution-completed': (payload: MetricsExecutionCompletedPayload) => void;
  'metrics:execution-failed': (payload: MetricsExecutionFailedPayload) => void;
  'metrics:response': (payload: MetricsResponsePayload) => void;

  // Error events
  'error': (payload: { code: string; message: string; details?: unknown }) => void;
}

// -----------------------------------------------------------------------------
// Client to Server Events
// -----------------------------------------------------------------------------

export interface ClientToServerEvents {
  // Session events
  'session:start': (callback: (sessionId: string) => void) => void;
  'session:message': (payload: { sessionId: string; content: string }) => void;
  'session:cancel': (payload: { sessionId: string }) => void;

  // Execution control
  'execution:pause': (payload: { sessionId: string }) => void;
  'execution:resume': (payload: { sessionId: string }) => void;

  // Canvas sync (client informing server of manual changes)
  'canvas:sync': (payload: { nodes: unknown[]; edges: unknown[] }) => void;

  // Phase 6: Runtime control
  'system:start': (payload: { sessionId: string; nodes: unknown[]; edges: unknown[]; brief: string }) => void;
  'system:stop': (payload: { sessionId: string }) => void;

  // Fixer: standalone Claude call for configuration fixes
  'fixer:start': (payload: { sessionId: string; prompt: string }) => void;
  'fixer:stop': (payload: { sessionId: string }) => void;
  'fixer:apply-patches': (payload: { sessionId: string; nodes?: unknown[]; edges?: unknown[] }) => void;

  // Canvas edge updates (client informing server of edge property changes)
  'canvas:update_edge': (payload: CanvasEdgeUpdatePayload) => void;

  // Metrics requests
  'metrics:request': (payload: MetricsRequestPayload) => void;
}

// -----------------------------------------------------------------------------
// Inter-Server Events (for internal use)
// -----------------------------------------------------------------------------

export interface InterServerEvents {
  ping: () => void;
}

// -----------------------------------------------------------------------------
// Socket Data (per-connection state)
// -----------------------------------------------------------------------------

export interface SocketData {
  sessionId?: string;
}

// =============================================================================
// Configuration Wizard Types
// Shared between frontend and backend for the AI-powered Configure feature
// =============================================================================

// ---------------------------------------------------------------------------
// Per-Node AI Suggestion
// ---------------------------------------------------------------------------

export interface ConfigSuggestion {
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  summary: string;
  overallScore: number; // 1-10
  suggestions: FieldSuggestion[];
  missingRequirements: MissingRequirement[];
  _parseFailed?: boolean; // true when AI response couldn't be parsed
}

export interface FieldSuggestion {
  field: string;
  currentValue: unknown;
  suggestedValue: unknown;
  reason: string;
  priority: 'high' | 'medium' | 'low' | 'none';
  accepted?: boolean; // tracked on frontend
}

export interface MissingRequirement {
  type: 'api_key' | 'env_var' | 'config_field' | 'connection';
  description: string;
  solution: string;
  nodeId?: string;                          // Which node this belongs to
  nodeLabel?: string;                       // Human-readable node name
  category: 'auto_fixable' | 'manual';     // Can an AI agent auto-fix this?
}

// ---------------------------------------------------------------------------
// Workflow-Level Scan (Deterministic, No AI)
// ---------------------------------------------------------------------------

export interface WorkflowAnalysis {
  overallHealth: 'good' | 'needs-attention' | 'critical';
  nodeIssues: NodeIssue[];
  missingRequirements: MissingRequirement[];
  orderOfAnalysis: string[]; // node IDs in recommended order
  configurableNodeCount: number;
  estimatedCost: number; // rough estimate in USD
}

export interface NodeIssue {
  nodeId: string;
  nodeLabel: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  solution: string;
}

// ---------------------------------------------------------------------------
// Wizard State
// ---------------------------------------------------------------------------

export type ConfigureNodeStatus =
  | 'pending'
  | 'analyzing'
  | 'ready'     // suggestion received, awaiting user decision
  | 'accepted'
  | 'skipped'
  | 'error';

export type ConfigurePhase = 'workflow-scan' | 'node-config' | 'summary';

// ---------------------------------------------------------------------------
// API Request/Response Types
// ---------------------------------------------------------------------------

export interface ConfigureWorkflowRequest {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    config: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    type?: string;
  }>;
}

export interface ConfigureNodeRequest {
  node: {
    id: string;
    type: string;
    label: string;
    config: Record<string, unknown>;
  };
  workflowContext: {
    nodeCount: number;
    edgeCount: number;
    connectedNodes: Array<{ type: string; label: string }>;
    workflowName: string;
  };
}

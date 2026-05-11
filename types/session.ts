// =============================================================================
// Session Management Types
// =============================================================================

import { SessionState, SessionMessage } from '../shared/socket-events';

export interface Session {
  id: string;
  state: SessionState;
  createdAt: number;
  updatedAt: number;

  // Conversation history
  messages: SessionMessage[];

  // Current execution context
  currentPlanId?: string;
  currentStepIndex?: number;

  // Variables created during execution (e.g., node IDs)
  variables: Record<string, string>;

  // Canvas state snapshot (for context)
  canvasSnapshot?: {
    nodes: unknown[];
    edges: unknown[];
  };
}

// Intent types detected by Supervisor
export type IntentType =
  | 'BUILD'      // Create new agents/workflows
  | 'EDIT'       // Modify existing nodes
  | 'QUERY'      // Ask questions about canvas/capabilities
  | 'EXPORT'     // Export workflow
  | 'CONFIGURE'  // Change settings
  | 'UNKNOWN';

export interface DetectedIntent {
  type: IntentType;
  confidence: number;
  entities?: {
    nodeTypes?: string[];
    nodeNames?: string[];
    actions?: string[];
  };
  rawIntent: string;
}

// Session store interface
export interface SessionStore {
  get(sessionId: string): Session | undefined;
  set(sessionId: string, session: Session): void;
  delete(sessionId: string): boolean;
  updateState(sessionId: string, state: SessionState): void;
  addMessage(sessionId: string, message: SessionMessage): void;
  setVariable(sessionId: string, key: string, value: string): void;
  getVariable(sessionId: string, key: string): string | undefined;
}

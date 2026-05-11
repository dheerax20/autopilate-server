// =============================================================================
// Socket.io Event Emitter Service
// Provides type-safe event emission to connected clients
// =============================================================================

import { Server as SocketServer, Socket } from 'socket.io';
import {
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
  CanvasNodePayload,
  CanvasNodeUpdatePayload,
  CanvasEdgePayload,
  SessionStatePayload,
  SessionMessagePayload,
  ExecutionStepPayload,
  ExecutionStepResultPayload,
  ExecutionLogPayload,
  AgentResultPayload,
  ExecutionReportPayload,
} from '../shared/socket-events';

// Type-safe Socket.io server
export type TypedSocketServer = SocketServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

// Singleton instance
let io: TypedSocketServer | null = null;

/**
 * Initialize the socket emitter with a Socket.io server instance
 */
export function initSocketEmitter(server: TypedSocketServer): void {
  io = server;
}

/**
 * Get the Socket.io server instance
 */
export function getSocketServer(): TypedSocketServer {
  if (!io) {
    throw new Error('Socket emitter not initialized. Call initSocketEmitter first.');
  }
  return io;
}

// -----------------------------------------------------------------------------
// Session Events
// -----------------------------------------------------------------------------

export function emitSessionStateChange(payload: SessionStatePayload): void {
  getSocketServer().emit('session:stateChange', payload);
}

export function emitSessionMessage(payload: SessionMessagePayload): void {
  getSocketServer().emit('session:message', payload);
}

// -----------------------------------------------------------------------------
// Canvas Events
// -----------------------------------------------------------------------------

export function emitNodeCreated(payload: CanvasNodePayload): void {
  getSocketServer().emit('node:created', payload);
}

export function emitNodeUpdated(payload: CanvasNodeUpdatePayload): void {
  getSocketServer().emit('node:updated', payload);
}

export function emitNodeDeleted(nodeId: string): void {
  getSocketServer().emit('node:deleted', { nodeId });
}

export function emitEdgeCreated(payload: CanvasEdgePayload): void {
  getSocketServer().emit('edge:created', payload);
}

export function emitEdgeDeleted(edgeId: string): void {
  getSocketServer().emit('edge:deleted', { edgeId });
}

// -----------------------------------------------------------------------------
// Execution Events
// -----------------------------------------------------------------------------

export function emitExecutionStepStart(payload: ExecutionStepPayload): void {
  getSocketServer().emit('execution:stepStart', payload);
}

export function emitExecutionStepComplete(payload: ExecutionStepResultPayload): void {
  getSocketServer().emit('execution:stepComplete', payload);
}

export function emitPlanComplete(
  sessionId: string,
  planId: string,
  success: boolean
): void {
  getSocketServer().emit('execution:planComplete', { sessionId, planId, success });
}

export function emitExecutionLog(
  sessionId: string,
  output: string,
  stream: 'stdout' | 'stderr' = 'stdout',
  source?: 'workflow' | 'fixer'
): void {
  getSocketServer().emit('execution:log', {
    sessionId,
    output,
    stream,
    timestamp: Date.now(),
    source,
  });
}

export function emitAgentResult(payload: AgentResultPayload): void {
  getSocketServer().emit('execution:agentResult', payload);
}

export function emitExecutionReport(payload: ExecutionReportPayload): void {
  getSocketServer().emit('execution:report', payload);
}

// -----------------------------------------------------------------------------
// Error Events
// -----------------------------------------------------------------------------

export function emitError(code: string, message: string, details?: unknown): void {
  getSocketServer().emit('error', { code, message, details });
}

// -----------------------------------------------------------------------------
// Utility: Emit to specific session
// -----------------------------------------------------------------------------

export function emitToSession<E extends keyof ServerToClientEvents>(
  sessionId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
): void {
  const server = getSocketServer();
  // Find sockets associated with this session
  server.sockets.sockets.forEach((socket) => {
    if (socket.data.sessionId === sessionId) {
      socket.emit(event, ...args);
    }
  });
}

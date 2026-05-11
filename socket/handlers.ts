// =============================================================================
// Socket.io Event Handlers
// Handles incoming events from connected clients
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { TypedSocket, TypedSocketServer } from './emitter';
import { SessionMessage, CanvasEdgeUpdatePayload } from '../shared/socket-events';
import { Session } from '../types/session';
import { createSupervisorAgent, SupervisorAgent } from '../agents/supervisor';
import { canvas_sync_from_client, canvasState, canvas_update_property, persistLayout, loadPersistedLayout } from '../mcp/canvas';
import { validateSystem } from '../services/runtime';
import { executeWorkflow, executeFixerAgent, stopExecution } from '../services/orchestrator-bridge';
import { SANDBOX_ROOT } from '../mcp/sandbox-mcp';
import { emitExecutionLog } from './emitter';
import { getSessionStore, FileSessionStore } from '../services/session-store';
import { setupMetricsSocketHandlers } from './metrics-emitter';

// File-backed session store — survives server restarts
const sessions: FileSessionStore = getSessionStore();

// Active supervisor agents per session
const supervisors = new Map<string, SupervisorAgent>();

// -----------------------------------------------------------------------------
// Helper: safely extract string/number/object from unknown values
// -----------------------------------------------------------------------------

interface ReactFlowNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  parentId?: string;
  data?: Record<string, unknown>;
}

interface ReactFlowEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  data?: Record<string, unknown>;
}

function asReactFlowNode(val: unknown): ReactFlowNode | null {
  if (!val || typeof val !== 'object') return null;
  const obj = val as Record<string, unknown>;
  if (typeof obj.id !== 'string') return null;
  return obj as unknown as ReactFlowNode;
}

function asReactFlowEdge(val: unknown): ReactFlowEdge | null {
  if (!val || typeof val !== 'object') return null;
  const obj = val as Record<string, unknown>;
  if (typeof obj.id !== 'string') return null;
  return obj as unknown as ReactFlowEdge;
}

// -----------------------------------------------------------------------------
// Session Management
// -----------------------------------------------------------------------------

function createSession(): Session {
  const sessionId = uuidv4();
  const session: Session = {
    id: sessionId,
    state: 'idle',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    variables: {},
  };
  sessions.set(sessionId, session);
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  return sessions.get(sessionId);
}

export function updateSessionState(
  sessionId: string,
  state: Session['state']
): void {
  sessions.updateState(sessionId, state);
}

export function addSessionMessage(
  sessionId: string,
  message: SessionMessage
): void {
  sessions.addMessage(sessionId, message);
}

/** Flush session data to disk (call during graceful shutdown) */
export function flushSessions(): void {
  sessions.flush();
}

// -----------------------------------------------------------------------------
// Socket Handler Setup
// -----------------------------------------------------------------------------

export function setupSocketHandlers(io: TypedSocketServer): void {
  io.on('connection', (socket: TypedSocket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Set up per-connection metrics handlers (metrics:request)
    setupMetricsSocketHandlers(socket);

    // Handle session start
    socket.on('session:start', (callback) => {
      const session = createSession();
      socket.data.sessionId = session.id;
      console.log(`[Socket] Session started: ${session.id}`);
      callback(session.id);
    });

    // Handle incoming messages
    socket.on('session:message', async (payload) => {
      const { sessionId, content } = payload;
      const session = sessions.get(sessionId);

      if (!session) {
        socket.emit('error', {
          code: 'SESSION_NOT_FOUND',
          message: `Session ${sessionId} not found`,
        });
        return;
      }

      const userMessage: SessionMessage = {
        id: uuidv4(),
        role: 'user',
        content,
        timestamp: Date.now(),
      };
      addSessionMessage(sessionId, userMessage);
      socket.emit('session:message', { sessionId, message: userMessage });

      let supervisor = supervisors.get(sessionId);
      if (!supervisor) {
        supervisor = createSupervisorAgent(sessionId);
        supervisors.set(sessionId, supervisor);
      }

      try {
        await supervisor.processMessage(content, session);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        socket.emit('error', {
          code: 'SUPERVISOR_ERROR',
          message: `Supervisor error: ${errorMessage}`,
        });
      }
    });

    // Handle session cancellation
    socket.on('session:cancel', (payload) => {
      const { sessionId } = payload;
      const session = sessions.get(sessionId);

      if (session) {
        const previousState = session.state;
        sessions.updateState(sessionId, 'idle');
        socket.emit('session:stateChange', {
          sessionId,
          state: 'idle',
          previousState,
        });
        console.log(`[Socket] Session cancelled: ${sessionId}`);
      }
    });

    // Handle execution pause
    socket.on('execution:pause', (payload) => {
      const { sessionId } = payload;
      const session = sessions.get(sessionId);

      if (session && session.state === 'executing') {
        sessions.updateState(sessionId, 'paused');

        const supervisor = supervisors.get(sessionId);
        supervisor?.pause();

        socket.emit('session:stateChange', {
          sessionId,
          state: 'paused',
          previousState: 'executing',
        });
        console.log(`[Socket] Execution paused: ${sessionId}`);
      }
    });

    // Handle execution resume
    socket.on('execution:resume', (payload) => {
      const { sessionId } = payload;
      const session = sessions.get(sessionId);

      if (session && session.state === 'paused') {
        sessions.updateState(sessionId, 'executing');

        const supervisor = supervisors.get(sessionId);
        supervisor?.resume();

        socket.emit('session:stateChange', {
          sessionId,
          state: 'executing',
          previousState: 'paused',
        });
        console.log(`[Socket] Execution resumed: ${sessionId}`);
      }
    });

    // Handle canvas sync from client
    socket.on('canvas:sync', (payload) => {
      const sessionId = socket.data.sessionId;
      if (!sessionId) return;

      const session = sessions.get(sessionId);
      if (!session) return;

      session.canvasSnapshot = {
        nodes: payload.nodes,
        edges: payload.edges,
      };
      session.updatedAt = Date.now();
      // Re-set to trigger persistence
      sessions.set(sessionId, session);

      // Map React Flow format to canvas MCP format
      const nodes = (payload.nodes as unknown[])
        .map(asReactFlowNode)
        .filter((n): n is ReactFlowNode => n !== null)
        .map((n) => ({
          id: n.id,
          type: (n.data?.nodeType as string)?.toLowerCase() || 'agent',
          label: (n.data?.label as string) || n.id,
          position: n.position,
          parentId: n.parentId,
          data: n.data || {},
        }));

      const edges = (payload.edges as unknown[])
        .map(asReactFlowEdge)
        .filter((e): e is ReactFlowEdge => e !== null)
        .map((e) => ({
          id: e.id,
          sourceId: e.source,
          targetId: e.target,
          edgeType: e.type || (e.data?.edgeType as string | undefined),
          data: e.data,
        }));

      canvas_sync_from_client(nodes, edges);
      console.log(`[Socket] Canvas synced for session: ${sessionId}`);
    });

    // Handle system start (real orchestrator execution)
    socket.on('system:start', async (payload) => {
      const { sessionId, nodes, edges, brief } = payload;

      if (!sessionId) {
        socket.emit('error', {
          code: 'INVALID_SESSION',
          message: 'Session ID required to start system',
        });
        return;
      }

      console.log(`[Socket] System start requested for session: ${sessionId}`);

      // Map node data for validation
      const nodeInfos = (nodes as unknown[])
        .map(asReactFlowNode)
        .filter((n): n is ReactFlowNode => n !== null)
        .map((n) => ({
          id: n.id,
          type: (n.data?.type as string) || n.type || 'UNKNOWN',
          label: (n.data?.label as string) || n.id,
        }));

      const edgeInfos = (edges as unknown[])
        .map(asReactFlowEdge)
        .filter((e): e is ReactFlowEdge => e !== null)
        .map((e) => ({
          id: e.id,
          sourceId: e.source,
          targetId: e.target,
          edgeType: e.type || (e.data?.edgeType as string | undefined) || (e.data?.type as string | undefined),
        }));

      // Pre-flight validation
      emitExecutionLog(sessionId, '[PRE-FLIGHT] Validating workflow graph...');
      const validation = validateSystem(nodeInfos, edgeInfos);

      if (validation.errors.length > 0) {
        validation.errors.forEach((err) =>
          emitExecutionLog(sessionId, `ERROR: ${err}`, 'stderr')
        );
        emitExecutionLog(sessionId, '');
        emitExecutionLog(sessionId, 'Validation failed. Fix errors before running.', 'stderr');
        return;
      }

      if (validation.warnings.length > 0) {
        validation.warnings.forEach((warn) =>
          emitExecutionLog(sessionId, `WARN: ${warn}`)
        );
      }
      emitExecutionLog(
        sessionId,
        `Validation passed: ${nodeInfos.length} nodes, ${edgeInfos.length} edges`
      );
      emitExecutionLog(sessionId, '');

      // Execute via real orchestrator engine
      try {
        await executeWorkflow(sessionId, nodes as Parameters<typeof executeWorkflow>[1], edges as Parameters<typeof executeWorkflow>[2], brief);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        emitExecutionLog(sessionId, `Runtime error: ${errorMessage}`, 'stderr');
        socket.emit('error', {
          code: 'RUNTIME_ERROR',
          message: `Runtime error: ${errorMessage}`,
        });
      }
    });

    // Handle system stop
    socket.on('system:stop', (payload) => {
      const { sessionId } = payload;
      console.log(`[Socket] System stop requested for session: ${sessionId}`);
      stopExecution(sessionId);
    });

    // Handle fixer:start — standalone Claude call for configuration fixes
    socket.on('fixer:start', async (payload) => {
      const { sessionId, prompt } = payload;

      if (!sessionId) {
        socket.emit('error', {
          code: 'INVALID_SESSION',
          message: 'Session ID required to start fixer',
        });
        return;
      }

      if (!prompt) {
        socket.emit('error', {
          code: 'MISSING_PROMPT',
          message: 'Fixer prompt is required',
        });
        return;
      }

      console.log(`[Socket] Fixer start requested for session: ${sessionId}`);

      try {
        await executeFixerAgent(sessionId, prompt);
        // Emit completion — for CLI path this fires immediately (terminal runs independently)
        // For API path this fires after the agent loop finishes
        emitExecutionLog(sessionId, 'Fixer launched — check Terminal.app for progress', 'stdout', 'fixer');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        emitExecutionLog(sessionId, `Fixer error: ${errorMessage}`, 'stderr', 'fixer');
        socket.emit('error', {
          code: 'FIXER_ERROR',
          message: `Fixer error: ${errorMessage}`,
        });
      }
    });

    // Handle fixer:apply-patches — read config-patches.json and apply to canvas nodes
    socket.on('fixer:apply-patches', async (payload) => {
      const { sessionId } = payload;
      const payloadNodes = (payload as Record<string, unknown>).nodes as unknown[] | undefined;
      const payloadEdges = (payload as Record<string, unknown>).edges as unknown[] | undefined;

      if (!sessionId) {
        socket.emit('error', {
          code: 'INVALID_SESSION',
          message: 'Session ID required to apply patches',
        });
        return;
      }

      console.log(`[Socket] Fixer apply-patches requested for session: ${sessionId}`);
      emitExecutionLog(sessionId, '[PATCHES] Reading config-patches.json...', 'stdout', 'fixer');

      const patchesPath = path.join(SANDBOX_ROOT, 'fixes', 'config-patches.json');

      if (!fs.existsSync(patchesPath)) {
        emitExecutionLog(sessionId, '[PATCHES] No config-patches.json found in sandbox/fixes/', 'stderr', 'fixer');
        socket.emit('error', {
          code: 'PATCHES_NOT_FOUND',
          message: 'No config-patches.json found. Run the fixer first.',
        });
        return;
      }

      try {
        // If the client sent live canvas state, sync it into canvasState first
        if (Array.isArray(payloadNodes) && payloadNodes.length > 0) {
          const nodes = payloadNodes
            .map(asReactFlowNode)
            .filter((n): n is ReactFlowNode => n !== null)
            .map((n) => ({
              id: n.id,
              type: (n.data?.nodeType as string)?.toLowerCase() || (n.data?.type as string)?.toLowerCase() || 'agent',
              label: (n.data?.label as string) || n.id,
              position: n.position,
              parentId: n.parentId,
              data: n.data || {},
            }));

          const edges = (payloadEdges || [])
            .map((e) => asReactFlowEdge(e))
            .filter((e): e is ReactFlowEdge => e !== null)
            .map((e) => ({
              id: e.id,
              sourceId: e.source,
              targetId: e.target,
              edgeType: e.type || (e.data?.edgeType as string | undefined),
              data: e.data,
            }));

          canvas_sync_from_client(nodes, edges);
          console.log(`[Socket] Synced ${nodes.length} nodes from apply-patches payload`);
          emitExecutionLog(sessionId, `[PATCHES] Synced ${nodes.length} nodes from live canvas`, 'stdout', 'fixer');
        }

        // Fallback: load from persisted layout if canvasState is still empty
        if (canvasState.nodes.size === 0) {
          console.log('[Socket] canvasState is empty, loading from persisted layout...');
          emitExecutionLog(sessionId, '[PATCHES] Canvas state empty, loading from persisted layout...', 'stdout', 'fixer');
          try {
            await loadPersistedLayout();
          } catch (loadErr) {
            console.error('[Socket] Failed to load persisted layout:', loadErr);
            emitExecutionLog(sessionId, `[PATCHES] WARN: Failed to load layout: ${loadErr}`, 'stderr', 'fixer');
          }
          console.log(`[Socket] Loaded ${canvasState.nodes.size} nodes from persisted layout`);
          emitExecutionLog(sessionId, `[PATCHES] Loaded ${canvasState.nodes.size} nodes from layout.json`, 'stdout', 'fixer');
        }

        if (canvasState.nodes.size === 0) {
          emitExecutionLog(sessionId, '[PATCHES] ERROR: No canvas nodes found. Open the canvas first.', 'stderr', 'fixer');
          socket.emit('error', {
            code: 'NO_CANVAS_STATE',
            message: 'No canvas nodes found. Make sure the canvas has nodes before applying patches.',
          });
          return;
        }

        emitExecutionLog(sessionId, `[PATCHES] Canvas has ${canvasState.nodes.size} nodes, processing patches...`, 'stdout', 'fixer');

        const raw = fs.readFileSync(patchesPath, 'utf-8');
        const patches = JSON.parse(raw) as Record<string, Record<string, unknown>>;

        const results: Array<{
          nodeLabel: string;
          fieldsApplied: string[];
          success: boolean;
          error?: string;
        }> = [];

        for (const [nodeLabel, patchObj] of Object.entries(patches)) {
          // Skip metadata keys (start with underscore)
          if (nodeLabel.startsWith('_')) continue;

          // Find the matching node by label in canvasState
          let matchedNodeId: string | null = null;
          for (const [nodeId, node] of canvasState.nodes) {
            if (node.label === nodeLabel) {
              matchedNodeId = nodeId;
              break;
            }
          }

          // Fallback: use nodeId from the patch itself if label lookup failed
          if (!matchedNodeId && typeof patchObj.nodeId === 'string') {
            if (canvasState.nodes.has(patchObj.nodeId)) {
              matchedNodeId = patchObj.nodeId;
              emitExecutionLog(
                sessionId,
                `[PATCHES] Label "${nodeLabel}" not found by name, using nodeId from patch: ${matchedNodeId}`,
                'stdout',
                'fixer'
              );
            }
          }

          if (!matchedNodeId) {
            emitExecutionLog(
              sessionId,
              `[PATCHES] WARN: No canvas node found with label "${nodeLabel}" — skipping`,
              'stderr',
              'fixer'
            );
            results.push({
              nodeLabel,
              fieldsApplied: [],
              success: false,
              error: `Node not found: "${nodeLabel}"`,
            });
            continue;
          }

          // Flatten the patch object: the fixer may produce nested structures like
          // { nodeId: "...", autoFixes: { skills: [...] }, userProvided: { mcps: [...] } }
          // We need to extract the actual config properties from autoFixes and userProvided
          const flatProps: Record<string, unknown> = {};

          for (const [key, value] of Object.entries(patchObj)) {
            if (key === 'nodeId') {
              // Skip metadata — not a config property
              continue;
            } else if ((key === 'autoFixes' || key === 'patches' || key === 'userProvided') && typeof value === 'object' && value !== null) {
              // Flatten nested grouping keys into top-level config properties
              for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
                // Each sub-entry might be a direct value OR an object with { description, value, instruction }
                const unwrapped = subValue as Record<string, unknown>;
                if (unwrapped && typeof unwrapped === 'object' && 'value' in unwrapped) {
                  // Extract the actual value from the wrapper
                  flatProps[subKey] = unwrapped.value;
                } else {
                  flatProps[subKey] = subValue;
                }
              }
            } else {
              // Already a flat property (backward compatible with simple format)
              flatProps[key] = value;
            }
          }

          const fieldsApplied: string[] = [];
          let nodeSuccess = true;

          // Apply each flattened property
          for (const [key, value] of Object.entries(flatProps)) {
            const propertyPath = key.startsWith('config.') ? key : `config.${key}`;
            const result = canvas_update_property({
              nodeId: matchedNodeId,
              propertyPath,
              value,
            });

            if (result.success) {
              fieldsApplied.push(key);
            } else {
              emitExecutionLog(
                sessionId,
                `[PATCHES] ERROR: Failed to set ${key} on "${nodeLabel}": ${result.error}`,
                'stderr',
                'fixer'
              );
              nodeSuccess = false;
            }
          }

          if (fieldsApplied.length > 0) {
            emitExecutionLog(
              sessionId,
              `[PATCHES] Applied ${fieldsApplied.length} field(s) to "${nodeLabel}": ${fieldsApplied.join(', ')}`,
              'stdout',
              'fixer'
            );
          }

          results.push({
            nodeLabel,
            fieldsApplied,
            success: nodeSuccess,
          });
        }

        // Persist layout after all patches
        await persistLayout();

        // Emit canvas:sync back to client so it refreshes
        const nodesArray = Array.from(canvasState.nodes.values()).map((n) => ({
          id: n.id,
          type: n.type,
          position: n.position,
          parentId: n.parentId,
          data: { ...n.data, label: n.label, nodeType: n.type, type: n.type },
        }));
        const edgesArray = Array.from(canvasState.edges.values()).map((e) => ({
          id: e.id,
          source: e.sourceId,
          target: e.targetId,
          type: e.edgeType,
          data: e.data,
        }));

        // Broadcast updated state to all clients in this session
        io.emit('node:updated', { nodeId: '__bulk_sync__', changes: {} });

        const totalApplied = results.filter((r) => r.success).length;
        const totalFailed = results.filter((r) => !r.success).length;

        emitExecutionLog(
          sessionId,
          `[PATCHES] Complete: ${totalApplied} node(s) patched, ${totalFailed} failed`,
          'stdout',
          'fixer'
        );

        socket.emit('fixer:patches-applied', {
          sessionId,
          results,
          totalApplied,
          totalFailed,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        emitExecutionLog(sessionId, `[PATCHES] Error: ${errorMessage}`, 'stderr', 'fixer');
        socket.emit('error', {
          code: 'PATCH_ERROR',
          message: `Failed to apply patches: ${errorMessage}`,
        });
      }
    });

    // Handle fixer:stop
    socket.on('fixer:stop', (payload) => {
      const { sessionId } = payload;
      console.log(`[Socket] Fixer stop requested for session: ${sessionId}`);
      stopExecution(sessionId);
    });

    // Handle edge type update from Properties Panel
    socket.on('canvas:update_edge', async (payload: CanvasEdgeUpdatePayload) => {
      const { edgeId, changes } = payload;

      const edge = canvasState.edges.get(edgeId);
      if (edge) {
        if (changes.data) {
          edge.data = { ...edge.data, ...changes.data };
        }
        canvasState.edges.set(edgeId, edge);

        await persistLayout();
        console.log(`[Socket] Updated edge ${edgeId} type to: ${changes.data?.type}`);
      } else {
        console.warn(`[Socket] Edge not found for update: ${edgeId}`);
      }
    });

    // Handle disconnect
    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Client disconnected: ${socket.id}, reason: ${reason}`);
    });
  });
}

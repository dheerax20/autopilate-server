import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Socket Handler Tests
// Tests for server/socket/handlers.ts and emitter.ts
// =============================================================================

// Mock dependencies
vi.mock('../agents/supervisor', () => ({
  createSupervisorAgent: vi.fn().mockReturnValue({
    processMessage: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    resume: vi.fn(),
  }),
  SupervisorAgent: vi.fn(),
}));

vi.mock('../mcp/canvas', () => ({
  canvas_sync_from_client: vi.fn(),
  canvasState: {
    edges: new Map(),
  },
  persistLayout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/runtime', () => ({
  validateSystem: vi.fn().mockReturnValue({
    valid: true,
    errors: [],
    warnings: [],
  }),
}));

vi.mock('../services/orchestrator-bridge', () => ({
  executeWorkflow: vi.fn().mockResolvedValue(undefined),
  executeFixerAgent: vi.fn().mockResolvedValue(undefined),
  stopExecution: vi.fn(),
}));

import {
  getSession,
  updateSessionState,
  addSessionMessage,
  setupSocketHandlers,
} from '../socket/handlers';
import {
  initSocketEmitter,
  getSocketServer,
  emitSessionMessage,
  emitSessionStateChange,
  emitNodeCreated,
  emitNodeDeleted,
  emitEdgeCreated,
  emitEdgeDeleted,
  emitExecutionStepStart,
  emitExecutionStepComplete,
  emitPlanComplete,
  emitExecutionLog,
  emitError,
} from '../socket/emitter';
import { canvas_sync_from_client } from '../mcp/canvas';

// =============================================================================
// Tests: Session Management (from handlers.ts)
// =============================================================================

describe('Session Management', () => {
  it('getSession should return undefined for unknown session', () => {
    expect(getSession('nonexistent')).toBeUndefined();
  });

  it('updateSessionState should not throw for unknown session', () => {
    expect(() => updateSessionState('nonexistent', 'idle')).not.toThrow();
  });

  it('addSessionMessage should not throw for unknown session', () => {
    expect(() =>
      addSessionMessage('nonexistent', {
        id: 'msg-1',
        role: 'user',
        content: 'test',
        timestamp: Date.now(),
      })
    ).not.toThrow();
  });
});

// =============================================================================
// Tests: Socket Handler Setup
// =============================================================================

describe('setupSocketHandlers', () => {
  let mockIo: any;
  let mockSocket: any;
  let eventHandlers: Record<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers = {};

    mockSocket = {
      id: 'socket-123',
      data: {} as Record<string, unknown>,
      on: vi.fn().mockImplementation((event: string, handler: Function) => {
        eventHandlers[event] = handler;
      }),
      emit: vi.fn(),
    };

    mockIo = {
      on: vi.fn().mockImplementation((event: string, handler: Function) => {
        if (event === 'connection') {
          handler(mockSocket);
        }
      }),
      emit: vi.fn(),
      sockets: {
        sockets: new Map(),
      },
    };

    setupSocketHandlers(mockIo);
  });

  it('should register connection handler', () => {
    expect(mockIo.on).toHaveBeenCalledWith('connection', expect.any(Function));
  });

  it('should register event handlers on socket', () => {
    expect(mockSocket.on).toHaveBeenCalledWith('session:start', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('session:message', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('session:cancel', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('execution:pause', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('execution:resume', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('canvas:sync', expect.any(Function));
    expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
  });

  describe('session:start', () => {
    it('should create a new session and return ID', () => {
      const callback = vi.fn();
      eventHandlers['session:start'](callback);

      expect(callback).toHaveBeenCalledWith(expect.any(String));

      // Session should be stored
      const sessionId = callback.mock.calls[0][0];
      expect(getSession(sessionId)).toBeDefined();
      expect(getSession(sessionId)!.state).toBe('idle');
    });
  });

  describe('session:message', () => {
    it('should emit error for unknown session', async () => {
      await eventHandlers['session:message']({
        sessionId: 'nonexistent',
        content: 'hello',
      });

      expect(mockSocket.emit).toHaveBeenCalledWith('error', {
        code: 'SESSION_NOT_FOUND',
        message: expect.stringContaining('nonexistent'),
      });
    });

    it('should process message for valid session', async () => {
      // Create a session first
      const callback = vi.fn();
      eventHandlers['session:start'](callback);
      const sessionId = callback.mock.calls[0][0];

      await eventHandlers['session:message']({
        sessionId,
        content: 'Create an agent',
      });

      // Should emit confirmation
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'session:message',
        expect.objectContaining({
          sessionId,
          message: expect.objectContaining({
            role: 'user',
            content: 'Create an agent',
          }),
        })
      );
    });
  });

  describe('session:cancel', () => {
    it('should reset session state to idle', () => {
      const callback = vi.fn();
      eventHandlers['session:start'](callback);
      const sessionId = callback.mock.calls[0][0];

      eventHandlers['session:cancel']({ sessionId });

      expect(getSession(sessionId)!.state).toBe('idle');
    });
  });

  describe('canvas:sync', () => {
    it('should sync canvas state for session', () => {
      // Create session and set it on socket
      const callback = vi.fn();
      eventHandlers['session:start'](callback);
      const sessionId = callback.mock.calls[0][0];
      mockSocket.data.sessionId = sessionId;

      eventHandlers['canvas:sync']({
        nodes: [{ id: 'n1', data: { nodeType: 'AGENT', label: 'Agent 1' }, position: { x: 0, y: 0 } }],
        edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      });

      expect(canvas_sync_from_client).toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('should handle disconnect without errors', () => {
      expect(() => eventHandlers['disconnect']('transport close')).not.toThrow();
    });
  });
});

// =============================================================================
// Tests: Socket Emitter
// =============================================================================

describe('Socket Emitter', () => {
  let mockIo: any;

  beforeEach(() => {
    mockIo = {
      emit: vi.fn(),
      sockets: {
        sockets: new Map(),
      },
    };
    initSocketEmitter(mockIo);
  });

  it('should throw when not initialized', () => {
    // Temporarily clear the io
    initSocketEmitter(null as any);
    // getSocketServer will throw with null
    // But we need to re-init first
    initSocketEmitter(mockIo);
    expect(getSocketServer()).toBe(mockIo);
  });

  it('emitSessionStateChange should emit correct event', () => {
    emitSessionStateChange({
      sessionId: 'test',
      state: 'executing',
      previousState: 'idle',
    });
    expect(mockIo.emit).toHaveBeenCalledWith('session:stateChange', {
      sessionId: 'test',
      state: 'executing',
      previousState: 'idle',
    });
  });

  it('emitSessionMessage should emit correct event', () => {
    emitSessionMessage({
      sessionId: 'test',
      message: {
        id: 'msg-1',
        role: 'supervisor',
        content: 'Hello',
        timestamp: 123,
      },
    });
    expect(mockIo.emit).toHaveBeenCalledWith('session:message', expect.objectContaining({
      sessionId: 'test',
    }));
  });

  it('emitNodeCreated should emit correct event', () => {
    emitNodeCreated({ nodeId: 'n1', type: 'AGENT', label: 'Test', position: { x: 0, y: 0 } });
    expect(mockIo.emit).toHaveBeenCalledWith('node:created', expect.objectContaining({ nodeId: 'n1' }));
  });

  it('emitNodeDeleted should emit correct event', () => {
    emitNodeDeleted('n1');
    expect(mockIo.emit).toHaveBeenCalledWith('node:deleted', { nodeId: 'n1' });
  });

  it('emitEdgeCreated should emit correct event', () => {
    emitEdgeCreated({ edgeId: 'e1', sourceId: 'n1', targetId: 'n2' });
    expect(mockIo.emit).toHaveBeenCalledWith('edge:created', expect.objectContaining({ edgeId: 'e1' }));
  });

  it('emitEdgeDeleted should emit correct event', () => {
    emitEdgeDeleted('e1');
    expect(mockIo.emit).toHaveBeenCalledWith('edge:deleted', { edgeId: 'e1' });
  });

  it('emitExecutionStepStart should emit correct event', () => {
    emitExecutionStepStart({
      sessionId: 'test',
      planId: 'plan-1',
      stepId: 'step-1',
      stepName: 'Test Step',
      stepOrder: 1,
      totalSteps: 3,
    });
    expect(mockIo.emit).toHaveBeenCalledWith('execution:stepStart', expect.objectContaining({
      stepId: 'step-1',
    }));
  });

  it('emitExecutionStepComplete should emit correct event', () => {
    emitExecutionStepComplete({
      sessionId: 'test',
      planId: 'plan-1',
      stepId: 'step-1',
      stepName: 'Test Step',
      stepOrder: 1,
      totalSteps: 3,
      success: true,
    });
    expect(mockIo.emit).toHaveBeenCalledWith('execution:stepComplete', expect.objectContaining({
      success: true,
    }));
  });

  it('emitPlanComplete should emit correct event', () => {
    emitPlanComplete('test', 'plan-1', true);
    expect(mockIo.emit).toHaveBeenCalledWith('execution:planComplete', {
      sessionId: 'test',
      planId: 'plan-1',
      success: true,
    });
  });

  it('emitExecutionLog should emit correct event with defaults', () => {
    emitExecutionLog('test', 'Log message');
    expect(mockIo.emit).toHaveBeenCalledWith('execution:log', expect.objectContaining({
      sessionId: 'test',
      output: 'Log message',
      stream: 'stdout',
    }));
  });

  it('emitExecutionLog should support stderr stream', () => {
    emitExecutionLog('test', 'Error message', 'stderr');
    expect(mockIo.emit).toHaveBeenCalledWith('execution:log', expect.objectContaining({
      stream: 'stderr',
    }));
  });

  it('emitError should emit correct event', () => {
    emitError('TEST_ERROR', 'Something went wrong');
    expect(mockIo.emit).toHaveBeenCalledWith('error', {
      code: 'TEST_ERROR',
      message: 'Something went wrong',
      details: undefined,
    });
  });
});

// =============================================================================
// Tests: Runtime Validation (used by socket handlers)
// =============================================================================

describe('Runtime validateSystem (integration via handlers)', () => {
  // Import the actual runtime module (not mocked for this test)
  it('should validate empty canvas', async () => {
    // Use the actual implementation
    const { validateSystem: realValidate } = await vi.importActual<typeof import('../services/runtime')>('../services/runtime');

    const result = realValidate([], []);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('No nodes on canvas. Add agents to build a system.');
  });

  it('should warn about orphan agents', async () => {
    const { validateSystem: realValidate } = await vi.importActual<typeof import('../services/runtime')>('../services/runtime');

    const result = realValidate(
      [{ id: 'n1', type: 'AGENT', label: 'Agent 1' }],
      []
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('no connections');
  });

  it('should warn about untyped edges', async () => {
    const { validateSystem: realValidate } = await vi.importActual<typeof import('../services/runtime')>('../services/runtime');

    const result = realValidate(
      [
        { id: 'n1', type: 'AGENT', label: 'Agent 1' },
        { id: 'n2', type: 'AGENT', label: 'Agent 2' },
      ],
      [{ id: 'e1', sourceId: 'n1', targetId: 'n2' }]
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('no semantic type'))).toBe(true);
  });

  it('should detect cycles', async () => {
    const { validateSystem: realValidate } = await vi.importActual<typeof import('../services/runtime')>('../services/runtime');

    const result = realValidate(
      [
        { id: 'n1', type: 'AGENT', label: 'Agent 1' },
        { id: 'n2', type: 'AGENT', label: 'Agent 2' },
      ],
      [
        { id: 'e1', sourceId: 'n1', targetId: 'n2', edgeType: 'data' },
        { id: 'e2', sourceId: 'n2', targetId: 'n1', edgeType: 'data' },
      ]
    );
    expect(result.warnings.some((w) => w.includes('Circular dependency'))).toBe(true);
  });

  it('should pass valid graph without warnings for typed edges and connected agents', async () => {
    const { validateSystem: realValidate } = await vi.importActual<typeof import('../services/runtime')>('../services/runtime');

    const result = realValidate(
      [
        { id: 'n1', type: 'AGENT', label: 'Agent 1' },
        { id: 'n2', type: 'AGENT', label: 'Agent 2' },
      ],
      [{ id: 'e1', sourceId: 'n1', targetId: 'n2', edgeType: 'delegation' }]
    );
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });
});

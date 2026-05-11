import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Agent Unit Tests
// Tests for supervisor.ts, architect.ts, builder.ts
// =============================================================================

// Mock socket emitter (used by all agents)
vi.mock('../socket/emitter', () => ({
  emitSessionMessage: vi.fn(),
  emitSessionStateChange: vi.fn(),
  emitExecutionStepStart: vi.fn(),
  emitExecutionStepComplete: vi.fn(),
  emitPlanComplete: vi.fn(),
  emitExecutionLog: vi.fn(),
  initSocketEmitter: vi.fn(),
  getSocketServer: vi.fn(),
}));

// Mock canvas MCP
vi.mock('../mcp/canvas', () => ({
  canvas_get_state: vi.fn().mockReturnValue({
    success: true,
    data: { nodes: [], edges: [] },
  }),
  canvas_create_node: vi.fn().mockReturnValue({
    success: true,
    data: { nodeId: 'mock-node-id' },
  }),
  canvas_connect_nodes: vi.fn().mockReturnValue({
    success: true,
    data: { edgeId: 'mock-edge-id' },
  }),
  canvas_update_property: vi.fn().mockReturnValue({ success: true }),
  canvas_delete_node: vi.fn().mockReturnValue({ success: true }),
  CANVAS_TOOLS: {},
}));

// Mock sandbox MCP
vi.mock('../mcp/sandbox-mcp', () => ({
  sandbox_create_file: vi.fn().mockResolvedValue({
    success: true,
    data: { path: '/mock/path' },
  }),
  SANDBOX_TOOLS: {},
  SANDBOX_ROOT: '/mock/sandbox',
}));

// Mock Anthropic client
vi.mock('../lib/anthropic-client', () => ({
  smartGenerate: vi.fn().mockResolvedValue({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          id: 'plan-1',
          version: '1.0',
          metadata: {
            name: 'Test Plan',
            description: 'A test plan',
            complexity: 'simple',
            estimatedSteps: 1,
          },
          context: {
            userIntent: 'test',
            existingNodes: [],
            existingEdges: [],
          },
          steps: [
            {
              id: 'step-1',
              order: 1,
              name: 'Create Agent',
              action: {
                type: 'CREATE_NODE',
                nodeType: 'agent',
                label: 'Test Agent',
              },
              dependsOn: [],
              output: { nodeIdVariable: 'agent_id' },
            },
          ],
        }),
      },
    ],
  }),
  getPoolStatus: vi.fn(),
}));

// Mock Google Generative AI
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: vi.fn().mockReturnValue({
      generateContent: vi.fn().mockResolvedValue({
        response: {
          text: () =>
            JSON.stringify({
              type: 'BUILD',
              confidence: 0.95,
              entities: { nodeTypes: ['agent'], actions: ['create'] },
              rawIntent: 'Create an agent',
            }),
        },
      }),
    }),
  })),
}));

// Must import after mocks are set up
import { SupervisorAgent, createSupervisorAgent } from '../agents/supervisor';
import { ArchitectAgent, createArchitectAgent } from '../agents/architect';
import { BuilderAgent, createBuilderAgent } from '../agents/builder';
import { emitSessionMessage, emitSessionStateChange } from '../socket/emitter';
import { ExecutionPlan, resolveVariables, resolveActionVariables } from '../types/execution-plan';
import { canvas_create_node } from '../mcp/canvas';
import { smartGenerate } from '../lib/anthropic-client';

const mockedCanvasCreateNode = vi.mocked(canvas_create_node);
const mockedSmartGenerate = vi.mocked(smartGenerate);

// =============================================================================
// Tests: Supervisor Agent
// =============================================================================

describe('SupervisorAgent', () => {
  let supervisor: SupervisorAgent;
  const sessionId = 'test-session-123';

  beforeEach(() => {
    vi.clearAllMocks();
    supervisor = createSupervisorAgent(sessionId);
  });

  it('should create a supervisor agent', () => {
    expect(supervisor).toBeInstanceOf(SupervisorAgent);
  });

  it('should be created via factory function', () => {
    const agent = createSupervisorAgent('another-session');
    expect(agent).toBeInstanceOf(SupervisorAgent);
  });

  describe('fallback intent detection', () => {
    it('should detect BUILD intent from keywords', async () => {
      // Create supervisor without Google API key to force fallback
      const origKey = process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_API_KEY;

      const sv = createSupervisorAgent(sessionId);
      const session = {
        id: sessionId,
        state: 'idle' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        variables: {},
      };

      await sv.processMessage('Create a new agent', session);

      // Should emit state changes and messages
      expect(emitSessionStateChange).toHaveBeenCalled();
      expect(emitSessionMessage).toHaveBeenCalled();

      process.env.GOOGLE_API_KEY = origKey;
    });

    it('should detect QUERY intent from question keywords', async () => {
      const origKey = process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_API_KEY;

      const sv = createSupervisorAgent(sessionId);
      const session = {
        id: sessionId,
        state: 'idle' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        variables: {},
      };

      await sv.processMessage('What is on the canvas?', session);

      expect(emitSessionMessage).toHaveBeenCalled();

      process.env.GOOGLE_API_KEY = origKey;
    });

    it('should detect EXPORT intent from export keywords', async () => {
      const origKey = process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_API_KEY;

      const sv = createSupervisorAgent(sessionId);
      const session = {
        id: sessionId,
        state: 'idle' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        variables: {},
      };

      await sv.processMessage('export my workflow as JSON', session);

      expect(emitSessionMessage).toHaveBeenCalled();

      process.env.GOOGLE_API_KEY = origKey;
    });

    it('should handle UNKNOWN intent gracefully', async () => {
      const origKey = process.env.GOOGLE_API_KEY;
      delete process.env.GOOGLE_API_KEY;

      const sv = createSupervisorAgent(sessionId);
      const session = {
        id: sessionId,
        state: 'idle' as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        variables: {},
      };

      await sv.processMessage('xyzzy plugh', session);

      // Should still emit messages even for unknown intent
      expect(emitSessionMessage).toHaveBeenCalled();

      process.env.GOOGLE_API_KEY = origKey;
    });
  });

  describe('pause/resume', () => {
    it('should delegate pause to builder agent', () => {
      // pause() should not throw even without a builder
      expect(() => supervisor.pause()).not.toThrow();
    });

    it('should delegate resume to builder agent', () => {
      expect(() => supervisor.resume()).not.toThrow();
    });
  });
});

// =============================================================================
// Tests: Architect Agent
// =============================================================================

describe('ArchitectAgent', () => {
  let architect: ArchitectAgent;
  const sessionId = 'test-session-456';

  beforeEach(() => {
    vi.clearAllMocks();
    architect = createArchitectAgent(sessionId);
  });

  it('should create an architect agent', () => {
    expect(architect).toBeInstanceOf(ArchitectAgent);
  });

  it('should generate a valid execution plan', async () => {
    const context = {
      userIntent: 'Create a test agent',
      existingNodes: [],
      existingEdges: [],
    };

    const plan = await architect.generatePlan('Create a test agent', context);

    expect(plan).not.toBeNull();
    expect(plan!.metadata.name).toBe('Test Plan');
    expect(plan!.steps.length).toBe(1);
    expect(plan!.steps[0].action.type).toBe('CREATE_NODE');
  });

  it('should return null when plan generation fails', async () => {
    mockedSmartGenerate.mockRejectedValueOnce(new Error('API error'));

    const context = {
      userIntent: 'Create something',
      existingNodes: [],
      existingEdges: [],
    };

    const plan = await architect.generatePlan('Create something', context);
    expect(plan).toBeNull();
  });

  it('should handle invalid JSON in response', async () => {
    mockedSmartGenerate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not valid json at all', citations: null }],
    } as any);

    const context = {
      userIntent: 'Create something',
      existingNodes: [],
      existingEdges: [],
    };

    const plan = await architect.generatePlan('Create something', context);
    expect(plan).toBeNull();
  });

  it('should handle response with no text content', async () => {
    mockedSmartGenerate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', name: 'something', id: 'tool_1', input: {} }],
    } as any);

    const context = {
      userIntent: 'Create something',
      existingNodes: [],
      existingEdges: [],
    };

    const plan = await architect.generatePlan('Create something', context);
    expect(plan).toBeNull();
  });

  it('should strip markdown code blocks from response', async () => {
    const planJson = JSON.stringify({
      id: 'plan-2',
      version: '1.0',
      metadata: {
        name: 'Markdown Plan',
        description: 'Wrapped in markdown',
        complexity: 'simple',
        estimatedSteps: 1,
      },
      steps: [
        {
          id: 'step-1',
          order: 1,
          name: 'Test Step',
          action: { type: 'CREATE_NODE', nodeType: 'agent', label: 'Agent' },
          dependsOn: [],
        },
      ],
    });

    mockedSmartGenerate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n' + planJson + '\n```' }],
    } as any);

    const context = {
      userIntent: 'Create agent',
      existingNodes: [],
      existingEdges: [],
    };

    const plan = await architect.generatePlan('Create agent', context);
    expect(plan).not.toBeNull();
    expect(plan!.metadata.name).toBe('Markdown Plan');
  });
});

// =============================================================================
// Tests: Builder Agent
// =============================================================================

describe('BuilderAgent', () => {
  let builder: BuilderAgent;
  const sessionId = 'test-session-789';

  beforeEach(() => {
    vi.clearAllMocks();
    builder = createBuilderAgent(sessionId);
  });

  it('should create a builder agent', () => {
    expect(builder).toBeInstanceOf(BuilderAgent);
  });

  it('should execute a simple plan successfully', async () => {
    const plan: ExecutionPlan = {
      id: 'plan-1',
      version: '1.0',
      metadata: {
        name: 'Simple Plan',
        description: 'Creates one agent',
        complexity: 'simple',
        estimatedSteps: 1,
      },
      context: {
        userIntent: 'Create an agent',
        existingNodes: [],
        existingEdges: [],
      },
      steps: [
        {
          id: 'step-1',
          order: 1,
          name: 'Create Agent',
          action: {
            type: 'CREATE_NODE',
            nodeType: 'agent',
            label: 'Test Agent',
          },
          dependsOn: [],
          output: { nodeIdVariable: 'agent_id' },
        },
      ],
    };

    const result = await builder.executePlan(plan);

    expect(result.status).toBe('completed');
    expect(result.stepResults.length).toBe(1);
    expect(result.stepResults[0].success).toBe(true);
    expect(result.variables.agent_id).toBe('mock-node-id');
  });

  it('should execute a plan with CONNECT_NODES action', async () => {
    const plan: ExecutionPlan = {
      id: 'plan-2',
      version: '1.0',
      metadata: {
        name: 'Connect Plan',
        description: 'Creates and connects nodes',
        complexity: 'moderate',
        estimatedSteps: 3,
      },
      context: {
        userIntent: 'Create connected agents',
        existingNodes: [],
        existingEdges: [],
      },
      steps: [
        {
          id: 'step-1',
          order: 1,
          name: 'Create Agent 1',
          action: { type: 'CREATE_NODE', nodeType: 'agent', label: 'Agent 1' },
          dependsOn: [],
          output: { nodeIdVariable: 'agent1_id' },
        },
        {
          id: 'step-2',
          order: 2,
          name: 'Create Agent 2',
          action: { type: 'CREATE_NODE', nodeType: 'agent', label: 'Agent 2' },
          dependsOn: [],
          output: { nodeIdVariable: 'agent2_id' },
        },
        {
          id: 'step-3',
          order: 3,
          name: 'Connect Agents',
          action: {
            type: 'CONNECT_NODES',
            sourceId: '${agent1_id}',
            targetId: '${agent2_id}',
            edgeType: 'delegation',
          },
          dependsOn: ['step-1', 'step-2'],
          output: { edgeIdVariable: 'edge_id' },
        },
      ],
    };

    const result = await builder.executePlan(plan);

    expect(result.status).toBe('completed');
    expect(result.stepResults.length).toBe(3);
    expect(result.stepResults.every((r) => r.success)).toBe(true);
    expect(result.variables.edge_id).toBe('mock-edge-id');
  });

  it('should handle step failure', async () => {
    mockedCanvasCreateNode.mockReturnValueOnce({
      success: false,
      error: 'Canvas full',
    });

    const plan: ExecutionPlan = {
      id: 'plan-3',
      version: '1.0',
      metadata: {
        name: 'Failing Plan',
        description: 'Will fail',
        complexity: 'simple',
        estimatedSteps: 1,
      },
      context: { userIntent: 'fail', existingNodes: [], existingEdges: [] },
      steps: [
        {
          id: 'step-1',
          order: 1,
          name: 'Will Fail',
          action: { type: 'CREATE_NODE', nodeType: 'agent', label: 'Fail' },
          dependsOn: [],
          retryCount: 1, // Only try once to speed up test
        },
      ],
    };

    const result = await builder.executePlan(plan);

    expect(result.status).toBe('failed');
    expect(result.stepResults[0].success).toBe(false);
  });

  it('should skip steps with unmet dependencies', async () => {
    mockedCanvasCreateNode.mockReturnValueOnce({
      success: false,
      error: 'Failed',
    });

    const plan: ExecutionPlan = {
      id: 'plan-4',
      version: '1.0',
      metadata: {
        name: 'Dep Plan',
        description: 'Has dependencies',
        complexity: 'moderate',
        estimatedSteps: 2,
      },
      context: { userIntent: 'test', existingNodes: [], existingEdges: [] },
      steps: [
        {
          id: 'step-1',
          order: 1,
          name: 'Create First',
          action: { type: 'CREATE_NODE', nodeType: 'agent', label: 'First' },
          dependsOn: [],
          output: { nodeIdVariable: 'first_id' },
          retryCount: 1,
        },
        {
          id: 'step-2',
          order: 2,
          name: 'Connect (depends on step-1)',
          action: {
            type: 'CONNECT_NODES',
            sourceId: '${first_id}',
            targetId: 'existing-node',
          },
          dependsOn: ['step-1'],
        },
      ],
    };

    const result = await builder.executePlan(plan);

    // Step 1 fails, plan should stop (step 2 never runs due to the break on failure)
    expect(result.status).toBe('failed');
  });

  it('should handle pause and resume', () => {
    expect(() => builder.pause()).not.toThrow();
    expect(() => builder.resume()).not.toThrow();
  });

  it('should handle DELETE_NODE action', async () => {
    const plan: ExecutionPlan = {
      id: 'plan-del',
      version: '1.0',
      metadata: {
        name: 'Delete Plan',
        description: 'Deletes a node',
        complexity: 'simple',
        estimatedSteps: 1,
      },
      context: { userIntent: 'delete', existingNodes: [], existingEdges: [] },
      steps: [
        {
          id: 'step-1',
          order: 1,
          name: 'Delete Node',
          action: { type: 'DELETE_NODE', nodeId: 'existing-node' },
          dependsOn: [],
        },
      ],
    };

    const result = await builder.executePlan(plan);
    expect(result.status).toBe('completed');
  });

  it('should handle CREATE_FILE action', async () => {
    const plan: ExecutionPlan = {
      id: 'plan-file',
      version: '1.0',
      metadata: {
        name: 'File Plan',
        description: 'Creates a file',
        complexity: 'simple',
        estimatedSteps: 1,
      },
      context: { userIntent: 'create file', existingNodes: [], existingEdges: [] },
      steps: [
        {
          id: 'step-1',
          order: 1,
          name: 'Create File',
          action: {
            type: 'CREATE_FILE',
            path: 'agents/test.md',
            content: '# Test',
          },
          dependsOn: [],
          output: { filePathVariable: 'file_path' },
        },
      ],
    };

    const result = await builder.executePlan(plan);
    expect(result.status).toBe('completed');
    expect(result.variables.file_path).toBe('agents/test.md');
  });

  it('should handle REGISTER_CAPABILITY action', async () => {
    const plan: ExecutionPlan = {
      id: 'plan-cap',
      version: '1.0',
      metadata: {
        name: 'Capability Plan',
        description: 'Registers a capability',
        complexity: 'simple',
        estimatedSteps: 1,
      },
      context: { userIntent: 'register', existingNodes: [], existingEdges: [] },
      steps: [
        {
          id: 'step-1',
          order: 1,
          name: 'Register Skill',
          action: {
            type: 'REGISTER_CAPABILITY',
            name: 'test-skill',
            capabilityType: 'skill',
            content: '# Test Skill',
            triggers: ['test'],
          },
          dependsOn: [],
          output: { filePathVariable: 'skill_path' },
        },
      ],
    };

    const result = await builder.executePlan(plan);
    expect(result.status).toBe('completed');
  });

  it('should provide tool definitions', () => {
    const tools = BuilderAgent.getToolDefinitions();
    expect(Array.isArray(tools)).toBe(true);
  });
});

// =============================================================================
// Tests: Execution Plan Utilities
// =============================================================================

describe('ExecutionPlan utilities', () => {
  describe('resolveVariables', () => {
    it('should resolve variable references', () => {
      const vars = { agent_id: 'node-123', edge_id: 'edge-456' };
      expect(resolveVariables('${agent_id}', vars)).toBe('node-123');
      expect(resolveVariables('prefix-${edge_id}-suffix', vars)).toBe('prefix-edge-456-suffix');
    });

    it('should throw for unresolved variables', () => {
      expect(() => resolveVariables('${unknown}', {})).toThrow('Unresolved variable: unknown');
    });

    it('should handle strings with no variables', () => {
      expect(resolveVariables('no-variables-here', {})).toBe('no-variables-here');
    });

    it('should resolve multiple variables in one string', () => {
      const vars = { a: '1', b: '2' };
      expect(resolveVariables('${a}-${b}', vars)).toBe('1-2');
    });
  });

  describe('resolveActionVariables', () => {
    it('should resolve variables in action objects', () => {
      const action = {
        type: 'CONNECT_NODES' as const,
        sourceId: '${src}',
        targetId: '${tgt}',
      };
      const vars = { src: 'node-1', tgt: 'node-2' };

      const resolved = resolveActionVariables(action, vars);
      expect(resolved.sourceId).toBe('node-1');
      expect(resolved.targetId).toBe('node-2');
    });

    it('should handle nested objects', () => {
      const action = {
        type: 'UPDATE_NODE' as const,
        nodeId: '${id}',
        changes: { label: '${name}' },
      };
      const vars = { id: 'node-1', name: 'New Name' };

      const resolved = resolveActionVariables(action, vars);
      expect(resolved.nodeId).toBe('node-1');
      expect((resolved as any).changes.label).toBe('New Name');
    });
  });
});

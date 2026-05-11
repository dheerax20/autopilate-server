import {
  SystemManifest,
  SystemBundle,
  AgentConfigSlim,
  MCPServerConfigSlim,
  TriggerPattern,
  SystemCategory,
} from '../../types/registry';

export function createTestManifest(
  overrides: Partial<SystemManifest> = {}
): SystemManifest {
  return {
    name: 'Test System',
    slug: 'test-system',
    description: 'A system for testing',
    version: '1.0.0',
    category: 'monitoring' as SystemCategory,
    requiredInputs: [],
    outputType: 'notification',
    estimatedCostUsd: 0.05,
    triggerPattern: 'cron' as TriggerPattern,
    nodeCount: 3,
    edgeCount: 2,
    ...overrides,
  };
}

export function createTestAgentConfig(
  overrides: Partial<AgentConfigSlim> = {}
): AgentConfigSlim {
  return {
    name: 'Test Agent',
    role: 'worker',
    description: 'Does test things',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'You are a test agent.',
    mcps: ['filesystem', 'browser'],
    ...overrides,
  };
}

export function createTestMcpConfig(
  overrides: Partial<MCPServerConfigSlim> = {}
): MCPServerConfigSlim {
  return {
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    env: { HOME: '/tmp' },
    ...overrides,
  };
}

export function createTestBundle(
  overrides: Partial<SystemBundle> = {}
): SystemBundle {
  const manifest = overrides.manifest ?? createTestManifest();
  return {
    manifest,
    canvasJson: { nodes: [], edges: [] },
    agentConfigs: {
      'lead-agent': createTestAgentConfig({ name: 'Lead Agent', role: 'lead' }),
      'worker-agent': createTestAgentConfig({ name: 'Worker Agent', role: 'worker' }),
    },
    mcpConfigs: [
      createTestMcpConfig({ name: 'filesystem' }),
      createTestMcpConfig({ name: 'browser', command: 'node', args: ['browser-server.js'] }),
    ],
    pm2Ecosystem: {
      apps: [
        {
          name: `autopilate-${manifest.slug}`,
          script: 'run.js',
          cwd: '/opt/openclaw/agents/test-system',
          interpreter: 'node',
          env: { NODE_ENV: 'production' },
        },
      ],
    },
    envExample: { API_KEY: 'sk-...' },
    createdAt: '2026-02-20T00:00:00.000Z',
    ...overrides,
  };
}

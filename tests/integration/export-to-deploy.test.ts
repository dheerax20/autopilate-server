import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { SystemBundle } from '../../types/registry';

// encryptSecrets requires ENCRYPTION_KEY (32 bytes hex = 64 chars)
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
}

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing modules under test
// ---------------------------------------------------------------------------

const mockPoolQuery = vi.fn();
vi.mock('../../db', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

vi.mock('../../services/pm2-manager', () => ({
  startProcess: vi.fn().mockResolvedValue({
    name: 'autopilate-multi-agent-orchestrator',
    status: 'online',
    pid: 5678,
    cpu: 0,
    memory: 0,
    uptime: Date.now(),
    restarts: 0,
  }),
  deleteProcess: vi.fn().mockResolvedValue(undefined),
  restartProcess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/trigger-factory', () => ({
  createTriggerConfig: vi.fn().mockResolvedValue({
    type: 'messaging',
    channels: [{ platform: 'slack', enabled: true }],
    routerEnabled: true,
    enabled: true,
  }),
  removeTriggerConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/anthropic-client', () => ({
  smartGenerate: vi.fn(),
  getPoolStatus: vi.fn().mockReturnValue({
    BUILDER: { primary: true, backup: false, models: {} },
    ARCHITECT: { primary: true, backup: false, models: {} },
  }),
}));

vi.mock('../../socket/emitter', () => ({
  emitSessionStateChange: vi.fn(),
  emitSessionMessage: vi.fn(),
  emitExecutionLog: vi.fn(),
  initSocketEmitter: vi.fn(),
}));

import { systemsRouter } from '../../routes/systems';
import { errorHandler, notFoundHandler } from '../../src/middleware/error-handler';

// ---------------------------------------------------------------------------
// Test Express App (minimal — just the systems router + error handler)
// ---------------------------------------------------------------------------

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/systems', systemsRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Fixture: 3-node canvas (orchestrator + 2 specialists)
// ---------------------------------------------------------------------------

function createThreeNodeBundle(): SystemBundle {
  return {
    manifest: {
      name: 'Multi-Agent Orchestrator',
      slug: 'multi-agent-orchestrator',
      description: 'Orchestrator with two specialist agents for web design tasks',
      version: '1.0.0',
      category: 'web-development',
      requiredInputs: [
        { name: 'task_description', type: 'string', description: 'What to build', required: true },
        { name: 'output_format', type: 'string', description: 'Desired output', required: false },
      ],
      outputType: 'web_artifact',
      estimatedCostUsd: 0.50,
      triggerPattern: 'messaging',
      nodeCount: 3,
      edgeCount: 2,
    },
    canvasJson: {
      nodes: [
        { id: 'node-1', type: 'AGENT', data: { label: 'Orchestrator', role: 'orchestrator' } },
        { id: 'node-2', type: 'AGENT', data: { label: 'Designer', role: 'specialist' } },
        { id: 'node-3', type: 'AGENT', data: { label: 'Developer', role: 'specialist' } },
      ],
      edges: [
        { id: 'edge-1', source: 'node-1', target: 'node-2' },
        { id: 'edge-2', source: 'node-1', target: 'node-3' },
      ],
    },
    agentConfigs: {
      orchestrator: {
        name: 'Orchestrator',
        role: 'orchestrator',
        description: 'Coordinates design and development tasks',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
        systemPrompt: 'You coordinate work between the designer and developer.',
        mcps: ['filesystem'],
      },
      designer: {
        name: 'Designer',
        role: 'specialist',
        description: 'Creates visual designs and layouts',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
        systemPrompt: 'You are a web designer.',
        mcps: ['browser'],
      },
      developer: {
        name: 'Developer',
        role: 'specialist',
        description: 'Implements designs as code',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
        systemPrompt: 'You are a frontend developer.',
        mcps: ['filesystem', 'browser'],
      },
    },
    mcpConfigs: [
      { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], env: {} },
      { name: 'browser', command: 'node', args: ['browser-server.js'], env: {} },
    ],
    pm2Ecosystem: {
      apps: [{
        name: 'autopilate-multi-agent-orchestrator',
        script: 'run.js',
        cwd: '/opt/openclaw/agents/multi-agent-orchestrator',
        interpreter: 'node',
        env: { NODE_ENV: 'production' },
      }],
    },
    envExample: { ANTHROPIC_API_KEY: 'sk-...' },
    createdAt: '2026-02-20T12:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Default deployment row returned by mock DB
// ---------------------------------------------------------------------------

const MOCK_DEPLOYMENT_ROW = {
  id: 'deploy-uuid-100',
  system_name: 'Multi-Agent Orchestrator',
  system_slug: 'multi-agent-orchestrator',
  manifest_json: createThreeNodeBundle().manifest,
  canvas_json: createThreeNodeBundle().canvasJson,
  openclaw_config: null,
  trigger_type: 'messaging',
  trigger_config: null,
  pm2_process_name: 'autopilate-multi-agent-orchestrator',
  secrets_encrypted: null,
  status: 'deployed',
  deployed_at: '2026-02-20T12:00:00.000Z',
  created_at: '2026-02-20T12:00:00.000Z',
  updated_at: '2026-02-20T12:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: Export → Deploy Pipeline', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
  });

  it('POST /api/systems registers a 3-node bundle and returns deployment record', async () => {
    // registerSystem INSERT → returns the deployment row
    mockPoolQuery.mockResolvedValueOnce({ rows: [MOCK_DEPLOYMENT_ROW], rowCount: 1 });

    const bundle = createThreeNodeBundle();
    const res = await request(app)
      .post('/api/systems')
      .send(bundle)
      .expect('Content-Type', /json/)
      .expect(201);

    // Verify deployment record shape
    expect(res.body.id).toBe('deploy-uuid-100');
    expect(res.body.systemName).toBe('Multi-Agent Orchestrator');
    expect(res.body.systemSlug).toBe('multi-agent-orchestrator');
    expect(res.body.status).toBe('deployed');
    expect(res.body.pm2ProcessName).toBe('autopilate-multi-agent-orchestrator');

    // Verify DB INSERT was called with correct params
    const insertCall = mockPoolQuery.mock.calls[0];
    expect((insertCall[0] as string)).toContain('INSERT INTO deployments');
    const params = insertCall[1] as unknown[];
    expect(params[0]).toBe('Multi-Agent Orchestrator');     // system_name
    expect(params[1]).toBe('multi-agent-orchestrator');      // system_slug
    expect(params[4]).toBe('messaging');                     // trigger_type
    expect(params[8]).toBe('deployed');                      // status
  });

  it('GET /api/systems returns the registered system in the list', async () => {
    // listSystems SELECT → returns the deployment row
    mockPoolQuery.mockResolvedValueOnce({ rows: [MOCK_DEPLOYMENT_ROW] });

    const res = await request(app)
      .get('/api/systems')
      .expect('Content-Type', /json/)
      .expect(200);

    expect(res.body.systems).toHaveLength(1);
    expect(res.body.systems[0].systemSlug).toBe('multi-agent-orchestrator');
    expect(res.body.systems[0].systemName).toBe('Multi-Agent Orchestrator');
  });

  it('GET /api/systems/:slug retrieves a specific deployed system', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [MOCK_DEPLOYMENT_ROW] });

    const res = await request(app)
      .get('/api/systems/multi-agent-orchestrator')
      .expect(200);

    expect(res.body.systemSlug).toBe('multi-agent-orchestrator');
    expect(res.body.manifestJson).toEqual(createThreeNodeBundle().manifest);
  });

  it('GET /api/systems/:slug returns 404 for non-existent system', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get('/api/systems/non-existent')
      .expect(404);
  });

  it('rejects POST /api/systems with invalid manifest (missing slug)', async () => {
    const invalidBundle = {
      manifest: {
        name: 'Test',
        // slug missing
        description: 'test',
        version: '1.0.0',
        category: 'web-development',
        requiredInputs: [],
        outputType: 'document',
        estimatedCostUsd: 0,
        triggerPattern: 'messaging',
        nodeCount: 1,
        edgeCount: 0,
      },
      canvasJson: {},
      agentConfigs: {},
      mcpConfigs: [],
      pm2Ecosystem: { apps: [] },
      envExample: {},
      createdAt: '2026-02-20T00:00:00.000Z',
    };

    const res = await request(app)
      .post('/api/systems')
      .send(invalidBundle)
      .expect(400);

    expect(res.body.error).toBe('Validation error');
  });

  it('rejects POST /api/systems with invalid slug format', async () => {
    const bundle = createThreeNodeBundle();
    bundle.manifest.slug = 'INVALID SLUG!';

    const res = await request(app)
      .post('/api/systems')
      .send(bundle)
      .expect(400);

    expect(res.body.error).toBe('Validation error');
  });

  it('returns 409 for duplicate slug', async () => {
    // Simulate unique constraint violation
    const pgError = new Error('duplicate key value violates unique constraint');
    (pgError as unknown as Record<string, string>).code = '23505';
    mockPoolQuery.mockRejectedValueOnce(pgError);

    const bundle = createThreeNodeBundle();
    const res = await request(app)
      .post('/api/systems')
      .send(bundle)
      .expect(409);

    expect(res.body.code).toBe('DUPLICATE_SLUG');
  });

  it('full pipeline: POST creates → GET lists → GET retrieves by slug', async () => {
    // Step 1: POST creates the deployment
    mockPoolQuery.mockResolvedValueOnce({ rows: [MOCK_DEPLOYMENT_ROW], rowCount: 1 });

    const bundle = createThreeNodeBundle();
    const createRes = await request(app)
      .post('/api/systems')
      .send(bundle)
      .expect(201);

    const createdSlug = createRes.body.systemSlug;
    expect(createdSlug).toBe('multi-agent-orchestrator');

    // Step 2: GET /api/systems lists it
    mockPoolQuery.mockResolvedValueOnce({ rows: [MOCK_DEPLOYMENT_ROW] });

    const listRes = await request(app)
      .get('/api/systems')
      .expect(200);

    const slugs = listRes.body.systems.map((s: { systemSlug: string }) => s.systemSlug);
    expect(slugs).toContain('multi-agent-orchestrator');

    // Step 3: GET /api/systems/:slug fetches the specific system
    mockPoolQuery.mockResolvedValueOnce({ rows: [MOCK_DEPLOYMENT_ROW] });

    const getRes = await request(app)
      .get(`/api/systems/${createdSlug}`)
      .expect(200);

    expect(getRes.body.id).toBe(createRes.body.id);
    expect(getRes.body.manifestJson.nodeCount).toBe(3);
    expect(getRes.body.manifestJson.edgeCount).toBe(2);
  });

  it('canvas JSON preserves all 3 nodes and 2 edges in the deployment', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [MOCK_DEPLOYMENT_ROW], rowCount: 1 });

    const bundle = createThreeNodeBundle();
    await request(app)
      .post('/api/systems')
      .send(bundle)
      .expect(201);

    // Verify the canvas JSON persisted to DB contains all nodes/edges
    const insertCall = mockPoolQuery.mock.calls[0];
    const canvasJsonParam = JSON.parse(insertCall[1][3] as string);
    expect(canvasJsonParam.nodes).toHaveLength(3);
    expect(canvasJsonParam.edges).toHaveLength(2);
    expect(canvasJsonParam.nodes.map((n: { id: string }) => n.id)).toEqual([
      'node-1', 'node-2', 'node-3',
    ]);
  });

  it('PM2 process name follows autopilate-<slug> convention', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [MOCK_DEPLOYMENT_ROW], rowCount: 1 });

    const bundle = createThreeNodeBundle();
    const res = await request(app)
      .post('/api/systems')
      .send(bundle)
      .expect(201);

    expect(res.body.pm2ProcessName).toBe(`autopilate-${bundle.manifest.slug}`);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { ProcessStatus } from '../../services/pm2-manager';
import type { DeploymentRecord } from '../../types/registry';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing modules under test
// ---------------------------------------------------------------------------

const mockListProcesses = vi.fn();
const mockRestartProcess = vi.fn();
vi.mock('../../services/pm2-manager', () => ({
  listProcesses: (...args: unknown[]) => mockListProcesses(...args),
  restartProcess: (...args: unknown[]) => mockRestartProcess(...args),
  startProcess: vi.fn(),
  deleteProcess: vi.fn(),
  stopProcess: vi.fn(),
}));

const mockGetSystem = vi.fn();
const mockListSystems = vi.fn();
vi.mock('../../services/registry', () => ({
  getSystem: (...args: unknown[]) => mockGetSystem(...args),
  listSystems: (...args: unknown[]) => mockListSystems(...args),
  registerSystem: vi.fn(),
  updateSystemStatus: vi.fn(),
  archiveSystem: vi.fn(),
}));

const mockSmartGenerate = vi.fn();
vi.mock('../../lib/anthropic-client', () => ({
  smartGenerate: (...args: unknown[]) => mockSmartGenerate(...args),
}));

const mockPoolQuery = vi.fn();
vi.mock('../../db', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

vi.mock('../../socket/emitter', () => ({
  emitSessionStateChange: vi.fn(),
  emitSessionMessage: vi.fn(),
  emitExecutionLog: vi.fn(),
  initSocketEmitter: vi.fn(),
}));

import { runSystemMonitor } from '../../services/system-monitor';
import type { Diagnosis } from '../../services/system-monitor';
import { operatorsRouter } from '../../routes/operators';
import { errorHandler, notFoundHandler } from '../../src/middleware/error-handler';

// ---------------------------------------------------------------------------
// Test Express App (operators routes)
// ---------------------------------------------------------------------------

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/operators', operatorsRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockLlmDiagnosis(kind: Diagnosis['kind'], detail: string) {
  mockSmartGenerate.mockResolvedValueOnce({
    content: [{ type: 'text', text: JSON.stringify({ kind, detail }) }],
  });
}

function makeCrashedProcess(name: string): ProcessStatus {
  return {
    name,
    pid: undefined,
    status: 'errored',
    cpu: 0,
    memory: 256 * 1024 * 1024,
    uptime: undefined,
    restarts: 15,
  };
}

const MOCK_DEPLOYMENT: DeploymentRecord = {
  id: 'deploy-uuid-op-1',
  systemName: 'Failing System',
  systemSlug: 'failing-system',
  manifestJson: {
    name: 'Failing System',
    slug: 'failing-system',
    description: 'A system that has failed',
    version: '1.0.0',
    category: 'monitoring',
    requiredInputs: [],
    outputType: 'notification',
    estimatedCostUsd: 0.05,
    triggerPattern: 'cron',
    nodeCount: 2,
    edgeCount: 1,
  },
  canvasJson: {},
  openclawConfig: { timeoutMs: 120_000, maxMemoryRestart: '256M' },
  triggerType: 'cron',
  triggerConfig: null,
  pm2ProcessName: 'autopilate-failing-system',
  secretsDecrypted: null,
  status: 'deployed',
  domain: null,
  tags: [],
  deployedAt: '2026-02-20T00:00:00.000Z',
  createdAt: '2026-02-20T00:00:00.000Z',
  updatedAt: '2026-02-20T00:00:00.000Z',
};

const MOCK_ACTION_UUID = '550e8400-e29b-41d4-a716-446655440000';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: Operator Remediation Cycle', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    mockRestartProcess.mockResolvedValue(undefined);
    mockGetSystem.mockResolvedValue(MOCK_DEPLOYMENT);
  });

  // -------------------------------------------------------------------------
  // Full cycle: detect → diagnose → fix → log
  // -------------------------------------------------------------------------
  describe('full remediation cycle', () => {
    it('detects unhealthy process, diagnoses rate_limit, applies fix, logs action', async () => {
      // 1. System monitor finds a crashed process
      mockListProcesses.mockResolvedValue([
        makeCrashedProcess('autopilate-failing-system'),
      ]);

      // 2. No recent execution errors in DB
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })                    // fetchRecentErrors
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })       // UPDATE deployments (rate limit fix)
        .mockResolvedValueOnce({ rows: [{ id: MOCK_ACTION_UUID }] }); // INSERT operator_actions

      // 3. LLM diagnoses rate_limit
      mockLlmDiagnosis('rate_limit', 'Rate limit exceeded on primary API key');

      // Run the full monitor cycle
      const actions = await runSystemMonitor();

      // Verify: action was taken
      expect(actions).toHaveLength(1);
      expect(actions[0].actionType).toBe('add_fallback_model');
      expect(actions[0].autoApplied).toBe(true);
      expect(actions[0].diagnosis.kind).toBe('rate_limit');
      expect(actions[0].systemSlug).toBe('failing-system');
      expect(actions[0].deploymentId).toBe('deploy-uuid-op-1');

      // Verify: process was restarted
      expect(mockRestartProcess).toHaveBeenCalledWith('autopilate-failing-system');

      // Verify: deployment config updated with fallback model
      const updateCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes('UPDATE deployments')
      );
      expect(updateCall).toBeDefined();
      const configJson = JSON.parse(updateCall![1][0] as string);
      expect(configJson.fallbackModel).toBe('claude-3-7-sonnet-20250219');
      expect(configJson.rateLimitMitigation).toBe(true);

      // Verify: action logged to operator_actions table
      const insertCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes('INSERT INTO operator_actions')
      );
      expect(insertCall).toBeDefined();
      const insertParams = insertCall![1] as unknown[];
      expect(insertParams[0]).toBe('deploy-uuid-op-1');       // deployment_id
      expect(insertParams[1]).toBe('system_monitor');          // operator_type
      expect(insertParams[2]).toBe('add_fallback_model');      // action_type
      expect(insertParams[6]).toBe(true);                      // auto_applied
    });

    it('detects timeout, doubles timeout config, logs action', async () => {
      mockListProcesses.mockResolvedValue([
        makeCrashedProcess('autopilate-failing-system'),
      ]);

      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })                    // fetchRecentErrors
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })       // UPDATE deployments (timeout)
        .mockResolvedValueOnce({ rows: [{ id: MOCK_ACTION_UUID }] }); // INSERT operator_actions

      mockLlmDiagnosis('timeout', 'Agent execution timed out after 120s');

      const actions = await runSystemMonitor();

      expect(actions).toHaveLength(1);
      expect(actions[0].actionType).toBe('increase_timeout');
      expect(actions[0].autoApplied).toBe(true);

      // Verify timeout was doubled from 120000 to 240000
      const updateCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes('UPDATE deployments')
      );
      const configJson = JSON.parse(updateCall![1][0] as string);
      expect(configJson.timeoutMs).toBe(240_000);
    });

    it('detects OOM, doubles memory limit, logs action', async () => {
      mockListProcesses.mockResolvedValue([
        makeCrashedProcess('autopilate-failing-system'),
      ]);

      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: MOCK_ACTION_UUID }] });

      mockLlmDiagnosis('oom', 'Process exceeded memory limit');

      const actions = await runSystemMonitor();

      expect(actions).toHaveLength(1);
      expect(actions[0].actionType).toBe('increase_memory');
      expect(actions[0].autoApplied).toBe(true);
      expect(actions[0].description).toContain('256M');
      expect(actions[0].description).toContain('512M');
    });

    it('detects malformed_config, flags without auto-applying', async () => {
      mockListProcesses.mockResolvedValue([
        makeCrashedProcess('autopilate-failing-system'),
      ]);

      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })              // fetchRecentErrors
        .mockResolvedValueOnce({ rows: [{ id: MOCK_ACTION_UUID }] }); // INSERT operator_actions

      mockLlmDiagnosis('malformed_config', 'Invalid JSON in CLAUDE.md');

      const actions = await runSystemMonitor();

      expect(actions).toHaveLength(1);
      expect(actions[0].actionType).toBe('flag_config_error');
      expect(actions[0].autoApplied).toBe(false);
      // Process should still be restarted even for non-auto-applied fixes
      expect(mockRestartProcess).toHaveBeenCalledWith('autopilate-failing-system');
    });
  });

  // -------------------------------------------------------------------------
  // Uses error logs in diagnosis
  // -------------------------------------------------------------------------
  describe('error log context in diagnosis', () => {
    it('passes recent error logs to LLM for diagnosis', async () => {
      mockListProcesses.mockResolvedValue([
        makeCrashedProcess('autopilate-failing-system'),
      ]);

      // Return error logs from DB
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [
            { error_message: 'RateLimitError: 429 Too Many Requests', completed_at: '2026-02-20T11:00:00Z' },
            { error_message: 'RateLimitError: 429 Too Many Requests', completed_at: '2026-02-20T11:01:00Z' },
          ],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })       // UPDATE deployments
        .mockResolvedValueOnce({ rows: [{ id: MOCK_ACTION_UUID }] }); // INSERT operator_actions

      mockLlmDiagnosis('rate_limit', 'Repeated 429 errors indicate rate limiting');

      await runSystemMonitor();

      // Verify LLM was called with error context
      expect(mockSmartGenerate).toHaveBeenCalledTimes(1);
      const llmCall = mockSmartGenerate.mock.calls[0];
      const userMessage = (llmCall[2] as Array<{ content: string }>)[0].content;
      expect(userMessage).toContain('autopilate-failing-system');
      expect(userMessage).toContain('RateLimitError');
    });
  });

  // -------------------------------------------------------------------------
  // Healthy system → no actions
  // -------------------------------------------------------------------------
  describe('healthy systems', () => {
    it('takes no action when all processes are healthy', async () => {
      mockListProcesses.mockResolvedValue([
        {
          name: 'autopilate-healthy-system',
          pid: 1234,
          status: 'online',
          cpu: 5,
          memory: 64 * 1024 * 1024,
          uptime: Date.now() - 60_000,
          restarts: 0,
        },
      ]);

      const actions = await runSystemMonitor();

      expect(actions).toHaveLength(0);
      expect(mockSmartGenerate).not.toHaveBeenCalled();
      expect(mockRestartProcess).not.toHaveBeenCalled();
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Operator actions API — GET + approve
  // -------------------------------------------------------------------------
  describe('operator actions API', () => {
    it('GET /api/operators/actions lists logged actions', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({
          rows: [{
            id: MOCK_ACTION_UUID,
            deployment_id: 'deploy-uuid-op-1',
            operator_type: 'system_monitor',
            action_type: 'add_fallback_model',
            description: 'Rate limit hit. Added fallback model.',
            before_state: { status: 'errored', restarts: 15 },
            after_state: { diagnosis: { kind: 'rate_limit', detail: 'Rate limited' } },
            auto_applied: true,
            approved: null,
            created_at: '2026-02-20T12:00:00.000Z',
            system_slug: 'failing-system',
          }],
        })
        .mockResolvedValueOnce({ rows: [{ count: '1' }] }); // COUNT query

      const res = await request(app)
        .get('/api/operators/actions')
        .expect(200);

      expect(res.body.actions).toHaveLength(1);
      expect(res.body.actions[0].actionType).toBe('add_fallback_model');
      expect(res.body.actions[0].operatorType).toBe('system_monitor');
      expect(res.body.actions[0].systemSlug).toBe('failing-system');
      expect(res.body.actions[0].autoApplied).toBe(true);
      expect(res.body.total).toBe(1);
    });

    it('GET /api/operators/actions filters by operator_type', async () => {
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const res = await request(app)
        .get('/api/operators/actions?operator_type=system_monitor')
        .expect(200);

      expect(res.body.actions).toHaveLength(0);

      // Verify the query includes the filter
      const selectCall = mockPoolQuery.mock.calls[0];
      expect((selectCall[0] as string)).toContain('oa.operator_type = $1');
      expect(selectCall[1]).toContain('system_monitor');
    });

    it('GET /api/operators/actions/pending lists unapproved actions', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: MOCK_ACTION_UUID,
          deployment_id: 'deploy-uuid-op-1',
          operator_type: 'system_monitor',
          action_type: 'flag_config_error',
          description: 'Malformed config detected',
          before_state: {},
          after_state: {},
          auto_applied: false,
          approved: null,
          created_at: '2026-02-20T12:00:00.000Z',
          system_slug: 'failing-system',
        }],
      });

      const res = await request(app)
        .get('/api/operators/actions/pending')
        .expect(200);

      expect(res.body.actions).toHaveLength(1);
      expect(res.body.actions[0].approved).toBeNull();
    });

    it('POST /api/operators/actions/:id/approve approves an action', async () => {
      // Fetch action
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: MOCK_ACTION_UUID,
          deployment_id: 'deploy-uuid-op-1',
          operator_type: 'system_monitor',
          action_type: 'flag_config_error',
          description: 'Malformed config',
          before_state: {},
          after_state: null,
          auto_applied: false,
          approved: null,
          created_at: '2026-02-20T12:00:00.000Z',
          system_slug: 'failing-system',
        }],
      });

      // UPDATE approved = true
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const res = await request(app)
        .post(`/api/operators/actions/${MOCK_ACTION_UUID}/approve`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.action.approved).toBe(true);

      // Verify UPDATE query was issued
      const updateCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes('UPDATE operator_actions SET approved = true')
      );
      expect(updateCall).toBeDefined();
    });

    it('POST /api/operators/actions/:id/reject rejects an action', async () => {
      // Fetch action
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: MOCK_ACTION_UUID, approved: null }],
      });

      // UPDATE approved = false
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const res = await request(app)
        .post(`/api/operators/actions/${MOCK_ACTION_UUID}/reject`)
        .expect(200);

      expect(res.body.success).toBe(true);
    });

    it('returns 409 when approving an already-approved action', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: MOCK_ACTION_UUID,
          deployment_id: 'deploy-uuid-op-1',
          operator_type: 'system_monitor',
          action_type: 'flag_config_error',
          description: 'Already handled',
          before_state: {},
          after_state: null,
          auto_applied: false,
          approved: true,
          created_at: '2026-02-20T12:00:00.000Z',
          system_slug: 'failing-system',
        }],
      });

      const res = await request(app)
        .post(`/api/operators/actions/${MOCK_ACTION_UUID}/approve`)
        .expect(409);

      expect(res.body.code).toBe('ALREADY_RESOLVED');
    });

    it('returns 404 when approving non-existent action', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });

      await request(app)
        .post(`/api/operators/actions/${MOCK_ACTION_UUID}/approve`)
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // Full cycle: monitor → log → API query
  // -------------------------------------------------------------------------
  describe('end-to-end: monitor detects → fixes → action queryable via API', () => {
    it('action logged by monitor appears in GET /api/operators/actions', async () => {
      // Step 1: Run the system monitor
      mockListProcesses.mockResolvedValue([
        makeCrashedProcess('autopilate-failing-system'),
      ]);

      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })              // fetchRecentErrors
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE deployments
        .mockResolvedValueOnce({ rows: [{ id: MOCK_ACTION_UUID }] }); // INSERT operator_actions

      mockLlmDiagnosis('rate_limit', 'Rate limited');

      const monitorActions = await runSystemMonitor();
      expect(monitorActions).toHaveLength(1);
      const loggedActionId = monitorActions[0].id;

      // Step 2: Query the action via API
      const actionRow = {
        id: loggedActionId,
        deployment_id: 'deploy-uuid-op-1',
        operator_type: 'system_monitor',
        action_type: 'add_fallback_model',
        description: monitorActions[0].description,
        before_state: { status: 'errored', restarts: 15 },
        after_state: { diagnosis: { kind: 'rate_limit', detail: 'Rate limited' } },
        auto_applied: true,
        approved: null,
        created_at: '2026-02-20T12:00:00.000Z',
        system_slug: 'failing-system',
      };

      mockPoolQuery
        .mockResolvedValueOnce({ rows: [actionRow] })
        .mockResolvedValueOnce({ rows: [{ count: '1' }] });

      const res = await request(app)
        .get('/api/operators/actions?operator_type=system_monitor')
        .expect(200);

      expect(res.body.actions).toHaveLength(1);
      expect(res.body.actions[0].id).toBe(loggedActionId);
      expect(res.body.actions[0].actionType).toBe('add_fallback_model');
      expect(res.body.actions[0].autoApplied).toBe(true);
    });
  });
});

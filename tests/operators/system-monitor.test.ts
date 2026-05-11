import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProcessStatus } from '../../services/pm2-manager';

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

const mockListProcesses = vi.fn();
const mockRestartProcess = vi.fn();
vi.mock('../../services/pm2-manager', () => ({
  listProcesses: (...args: unknown[]) => mockListProcesses(...args),
  restartProcess: (...args: unknown[]) => mockRestartProcess(...args),
}));

const mockGetSystem = vi.fn();
vi.mock('../../services/registry', () => ({
  getSystem: (...args: unknown[]) => mockGetSystem(...args),
}));

const mockSmartGenerate = vi.fn();
vi.mock('../../lib/anthropic-client', () => ({
  smartGenerate: (...args: unknown[]) => mockSmartGenerate(...args),
}));

const mockPoolQuery = vi.fn();
vi.mock('../../db', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

import { runSystemMonitor, diagnoseWithLlm } from '../../services/system-monitor';
import type { Diagnosis } from '../../services/system-monitor';

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
    memory: 128 * 1024 * 1024,
    uptime: undefined,
    restarts: 15,
  };
}

function makeHealthyProcess(name: string): ProcessStatus {
  return {
    name,
    pid: 1234,
    status: 'online',
    cpu: 5,
    memory: 64 * 1024 * 1024,
    uptime: Date.now() - 60_000,
    restarts: 0,
  };
}

const MOCK_DEPLOYMENT = {
  id: 'deploy-uuid-1',
  systemName: 'Test System',
  systemSlug: 'test-system',
  manifestJson: { slug: 'test-system' },
  canvasJson: {},
  openclawConfig: { timeoutMs: 120_000, maxMemoryRestart: '256M' },
  triggerType: 'cron' as const,
  triggerConfig: null,
  pm2ProcessName: 'autopilate-test-system',
  status: 'deployed' as const,
  deployedAt: '2026-02-20T00:00:00.000Z',
  createdAt: '2026-02-20T00:00:00.000Z',
  updatedAt: '2026-02-20T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('System Monitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRestartProcess.mockResolvedValue(undefined);
    mockGetSystem.mockResolvedValue(MOCK_DEPLOYMENT);
    // Default: no recent errors
    mockPoolQuery.mockResolvedValue({ rows: [] });
  });

  // -------------------------------------------------------------------------
  // No actions when healthy
  // -------------------------------------------------------------------------
  describe('healthy processes', () => {
    it('returns no actions when all processes are healthy', async () => {
      mockListProcesses.mockResolvedValue([
        makeHealthyProcess('autopilate-system-a'),
        makeHealthyProcess('autopilate-system-b'),
      ]);

      const actions = await runSystemMonitor();

      expect(actions).toHaveLength(0);
      expect(mockSmartGenerate).not.toHaveBeenCalled();
      expect(mockRestartProcess).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Diagnosis and fix: expired_key
  // -------------------------------------------------------------------------
  describe('expired_key diagnosis', () => {
    it('auto-applies key rotation when backup keys are present', async () => {
      process.env.BUILDER_KEY_BACKUP = 'sk-backup-123';
      mockListProcesses.mockResolvedValue([makeCrashedProcess('autopilate-test-system')]);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] }) // fetchRecentErrors
        .mockResolvedValueOnce({ rows: [{ id: 'action-1' }] }); // logOperatorAction
      mockLlmDiagnosis('expired_key', 'API key expired');

      const actions = await runSystemMonitor();

      expect(actions).toHaveLength(1);
      expect(actions[0].actionType).toBe('key_rotation_available');
      expect(actions[0].autoApplied).toBe(true);
      expect(mockRestartProcess).toHaveBeenCalledWith('autopilate-test-system');

      delete process.env.BUILDER_KEY_BACKUP;
    });

    it('flags for manual rotation when no backup keys', async () => {
      delete process.env.BUILDER_KEY_BACKUP;
      delete process.env.ARCHITECT_KEY_BACKUP;
      mockListProcesses.mockResolvedValue([makeCrashedProcess('autopilate-test-system')]);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'action-2' }] });
      mockLlmDiagnosis('expired_key', 'API key expired');

      const actions = await runSystemMonitor();

      expect(actions).toHaveLength(1);
      expect(actions[0].actionType).toBe('key_rotation_needed');
      expect(actions[0].autoApplied).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Diagnosis and fix: rate_limit (fallback model)
  // -------------------------------------------------------------------------
  describe('rate_limit diagnosis', () => {
    it('adds fallback model and auto-applies', async () => {
      mockListProcesses.mockResolvedValue([makeCrashedProcess('autopilate-test-system')]);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })            // fetchRecentErrors
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE deployments
        .mockResolvedValueOnce({ rows: [{ id: 'action-3' }] }); // logOperatorAction
      mockLlmDiagnosis('rate_limit', 'Rate limit exceeded on claude-opus-4-20250514');

      const actions = await runSystemMonitor();

      expect(actions).toHaveLength(1);
      expect(actions[0].actionType).toBe('add_fallback_model');
      expect(actions[0].autoApplied).toBe(true);
      expect(actions[0].diagnosis.kind).toBe('rate_limit');

      // Verify DB update was called with fallback model
      const updateCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes('UPDATE deployments')
      );
      expect(updateCall).toBeDefined();
      const configJson = JSON.parse(updateCall![1][0] as string);
      expect(configJson.fallbackModel).toBe('claude-3-7-sonnet-20250219');
      expect(configJson.rateLimitMitigation).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Diagnosis and fix: timeout (doubled timeout)
  // -------------------------------------------------------------------------
  describe('timeout diagnosis', () => {
    it('doubles timeout and auto-applies', async () => {
      mockListProcesses.mockResolvedValue([makeCrashedProcess('autopilate-test-system')]);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'action-4' }] });
      mockLlmDiagnosis('timeout', 'Request timed out after 120s');

      const actions = await runSystemMonitor();

      expect(actions).toHaveLength(1);
      expect(actions[0].actionType).toBe('increase_timeout');
      expect(actions[0].autoApplied).toBe(true);

      const updateCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes('UPDATE deployments')
      );
      const configJson = JSON.parse(updateCall![1][0] as string);
      expect(configJson.timeoutMs).toBe(240_000); // doubled from 120_000
    });
  });

  // -------------------------------------------------------------------------
  // Diagnosis and fix: oom (doubled memory)
  // -------------------------------------------------------------------------
  describe('oom diagnosis', () => {
    it('doubles memory limit and auto-applies', async () => {
      mockListProcesses.mockResolvedValue([makeCrashedProcess('autopilate-test-system')]);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'action-5' }] });
      mockLlmDiagnosis('oom', 'Process exceeded 256MB memory limit');

      const actions = await runSystemMonitor();

      expect(actions).toHaveLength(1);
      expect(actions[0].actionType).toBe('increase_memory');
      expect(actions[0].autoApplied).toBe(true);
      expect(actions[0].description).toContain('256M');
      expect(actions[0].description).toContain('512M');
    });
  });

  // -------------------------------------------------------------------------
  // Diagnosis: malformed_config — NOT auto-applied
  // -------------------------------------------------------------------------
  describe('malformed_config diagnosis', () => {
    it('flags but does NOT auto-apply', async () => {
      mockListProcesses.mockResolvedValue([makeCrashedProcess('autopilate-test-system')]);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'action-6' }] });
      mockLlmDiagnosis('malformed_config', 'Invalid JSON in agent config');

      const actions = await runSystemMonitor();

      expect(actions).toHaveLength(1);
      expect(actions[0].actionType).toBe('flag_config_error');
      expect(actions[0].autoApplied).toBe(false);
      // Process should still be restarted
      expect(mockRestartProcess).toHaveBeenCalledWith('autopilate-test-system');
    });
  });

  // -------------------------------------------------------------------------
  // Diagnosis: dependency_failure — NOT auto-applied
  // -------------------------------------------------------------------------
  describe('dependency_failure diagnosis', () => {
    it('flags but does NOT auto-apply', async () => {
      mockListProcesses.mockResolvedValue([makeCrashedProcess('autopilate-test-system')]);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'action-7' }] });
      mockLlmDiagnosis('dependency_failure', 'MCP server filesystem unreachable');

      const actions = await runSystemMonitor();

      expect(actions).toHaveLength(1);
      expect(actions[0].actionType).toBe('flag_dependency');
      expect(actions[0].autoApplied).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Action logging to operator_actions table
  // -------------------------------------------------------------------------
  describe('action logging', () => {
    it('logs action to operator_actions table with correct fields', async () => {
      mockListProcesses.mockResolvedValue([makeCrashedProcess('autopilate-test-system')]);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'logged-action-1' }] });
      mockLlmDiagnosis('malformed_config', 'Bad config');

      const actions = await runSystemMonitor();

      // Find the INSERT INTO operator_actions call
      const insertCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes('INSERT INTO operator_actions')
      );
      expect(insertCall).toBeDefined();

      const params = insertCall![1] as unknown[];
      expect(params[0]).toBe('deploy-uuid-1');       // deployment_id
      expect(params[1]).toBe('system_monitor');       // operator_type
      expect(params[2]).toBe('flag_config_error');    // action_type
      expect(params[6]).toBe(false);                  // auto_applied

      expect(actions[0].id).toBe('logged-action-1');
      expect(actions[0].deploymentId).toBe('deploy-uuid-1');
      expect(actions[0].systemSlug).toBe('test-system');
    });
  });

  // -------------------------------------------------------------------------
  // Process restart is called after fix
  // -------------------------------------------------------------------------
  describe('process restart', () => {
    it('restarts the unhealthy process after applying fix', async () => {
      mockListProcesses.mockResolvedValue([makeCrashedProcess('autopilate-test-system')]);
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'action-8' }] });
      mockLlmDiagnosis('malformed_config', 'Bad JSON');

      await runSystemMonitor();

      expect(mockRestartProcess).toHaveBeenCalledWith('autopilate-test-system');
    });
  });

  // -------------------------------------------------------------------------
  // diagnoseWithLlm unit test
  // -------------------------------------------------------------------------
  describe('diagnoseWithLlm', () => {
    it('parses valid LLM diagnosis JSON', async () => {
      mockSmartGenerate.mockResolvedValue({
        content: [{ type: 'text', text: '{"kind":"oom","detail":"Out of memory"}' }],
      });

      const proc = makeCrashedProcess('autopilate-test');
      const result = await diagnoseWithLlm(proc, 'Error: heap out of memory');

      expect(result.kind).toBe('oom');
      expect(result.detail).toBe('Out of memory');
    });

    it('returns unknown for invalid JSON response', async () => {
      mockSmartGenerate.mockResolvedValue({
        content: [{ type: 'text', text: 'This is not JSON' }],
      });

      const proc = makeCrashedProcess('autopilate-test');
      const result = await diagnoseWithLlm(proc, '');

      expect(result.kind).toBe('unknown');
    });

    it('returns unknown for invalid kind value', async () => {
      mockSmartGenerate.mockResolvedValue({
        content: [{ type: 'text', text: '{"kind":"banana","detail":"fruit error"}' }],
      });

      const proc = makeCrashedProcess('autopilate-test');
      const result = await diagnoseWithLlm(proc, '');

      expect(result.kind).toBe('unknown');
    });
  });

  // -------------------------------------------------------------------------
  // No deployment record found
  // -------------------------------------------------------------------------
  describe('missing deployment record', () => {
    it('skips process when no deployment record exists', async () => {
      mockListProcesses.mockResolvedValue([makeCrashedProcess('autopilate-unknown-system')]);
      mockGetSystem.mockResolvedValue(null);

      const actions = await runSystemMonitor();

      expect(actions).toHaveLength(0);
      expect(mockSmartGenerate).not.toHaveBeenCalled();
    });
  });
});

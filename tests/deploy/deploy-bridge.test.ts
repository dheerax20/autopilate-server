import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { createTestBundle, createTestManifest } from './fixtures';

// ---------------------------------------------------------------------------
// Mock all dependencies before importing deploy-bridge
// ---------------------------------------------------------------------------

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

const mockRegisterSystem = vi.fn();
const mockUpdateSystemStatus = vi.fn();
vi.mock('../../services/registry', () => ({
  registerSystem: (...args: unknown[]) => mockRegisterSystem(...args),
  updateSystemStatus: (...args: unknown[]) => mockUpdateSystemStatus(...args),
}));

const mockCreateTriggerConfig = vi.fn();
const mockRemoveTriggerConfig = vi.fn();
vi.mock('../../services/trigger-factory', () => ({
  createTriggerConfig: (...args: unknown[]) => mockCreateTriggerConfig(...args),
  removeTriggerConfig: (...args: unknown[]) => mockRemoveTriggerConfig(...args),
}));

const mockPoolQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
vi.mock('../../db', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

import * as fs from 'fs/promises';
import { deploySystem, DeployError } from '../../services/deploy-bridge';

const OPENCLAW_ROOT = '/opt/openclaw';

// ---------------------------------------------------------------------------
// Default mock returns for happy path
// ---------------------------------------------------------------------------
function setupHappyPath() {
  const triggerConfig = { type: 'cron', expression: '*/5 * * * *', timezone: 'UTC', enabled: true };
  const deploymentRecord = {
    id: 'uuid-123',
    systemName: 'Test System',
    systemSlug: 'test-system',
    manifestJson: createTestManifest(),
    canvasJson: { nodes: [], edges: [] },
    openclawConfig: null,
    triggerType: 'cron',
    triggerConfig: null,
    pm2ProcessName: 'autopilate-test-system',
    status: 'deployed',
    deployedAt: '2026-02-20T00:00:00.000Z',
    createdAt: '2026-02-20T00:00:00.000Z',
    updatedAt: '2026-02-20T00:00:00.000Z',
  };

  mockCreateTriggerConfig.mockResolvedValue(triggerConfig);
  mockRegisterSystem.mockResolvedValue(deploymentRecord);
  mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  mockUpdateSystemStatus.mockResolvedValue(undefined);
  mockRemoveTriggerConfig.mockResolvedValue(undefined);

  return { triggerConfig, deploymentRecord };
}

describe('Deploy Bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fs mock implementations (clearAllMocks only clears call history)
    (fs.mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fs.rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------
  describe('successful deployment', () => {
    it('writes agent CLAUDE.md files for each agent', async () => {
      setupHappyPath();
      const bundle = createTestBundle();

      await deploySystem(bundle, OPENCLAW_ROOT);

      // Should create dirs for both agents
      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join(OPENCLAW_ROOT, 'agents', 'test-system', 'lead-agent'),
        { recursive: true }
      );
      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join(OPENCLAW_ROOT, 'agents', 'test-system', 'worker-agent'),
        { recursive: true }
      );

      // Should write CLAUDE.md for each
      const writeFileCalls = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls;
      const claudeMdPaths = writeFileCalls
        .map((c: unknown[]) => c[0] as string)
        .filter((p: string) => p.endsWith('CLAUDE.md'));
      expect(claudeMdPaths).toHaveLength(2);
    });

    it('writes MCP config files for each MCP server', async () => {
      setupHappyPath();
      const bundle = createTestBundle();

      await deploySystem(bundle, OPENCLAW_ROOT);

      // MCP dir creation
      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join(OPENCLAW_ROOT, 'config', 'mcp', 'test-system'),
        { recursive: true }
      );

      // Two MCP config files
      const writeFileCalls = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls;
      const mcpPaths = writeFileCalls
        .map((c: unknown[]) => c[0] as string)
        .filter((p: string) => p.includes('/config/mcp/'));
      expect(mcpPaths).toHaveLength(2);
      expect(mcpPaths).toContain(path.join(OPENCLAW_ROOT, 'config', 'mcp', 'test-system', 'filesystem.json'));
      expect(mcpPaths).toContain(path.join(OPENCLAW_ROOT, 'config', 'mcp', 'test-system', 'browser.json'));
    });

    it('creates trigger config via trigger factory', async () => {
      setupHappyPath();
      const bundle = createTestBundle();

      await deploySystem(bundle, OPENCLAW_ROOT);

      expect(mockCreateTriggerConfig).toHaveBeenCalledWith(
        'cron',
        bundle.manifest,
        OPENCLAW_ROOT
      );
    });

    it('registers deployment in the database', async () => {
      setupHappyPath();
      const bundle = createTestBundle();

      await deploySystem(bundle, OPENCLAW_ROOT);

      expect(mockRegisterSystem).toHaveBeenCalledWith(bundle);
    });

    it('returns the deployment record with trigger and openclaw config', async () => {
      const { deploymentRecord } = setupHappyPath();
      const bundle = createTestBundle();

      const result = await deploySystem(bundle, OPENCLAW_ROOT);

      expect(result.id).toBe(deploymentRecord.id);
      expect(result.systemSlug).toBe('test-system');
      expect(result.openclawConfig).toEqual({
        agentDir: 'agents/test-system',
        mcpDir: 'config/mcp/test-system',
        triggerFile: 'config/triggers/test-system.json',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Atomic rollback
  // ---------------------------------------------------------------------------
  describe('atomic rollback on failure', () => {
    it('cleans up files when registry registration fails', async () => {
      setupHappyPath();
      mockRegisterSystem.mockRejectedValue(new Error('DB insert failed'));
      const bundle = createTestBundle();

      await expect(deploySystem(bundle, OPENCLAW_ROOT)).rejects.toThrow(DeployError);

      // Registry update is skipped (registration never completed)
      expect(mockUpdateSystemStatus).not.toHaveBeenCalled();

      // Should remove trigger config (step 3 succeeded)
      expect(mockRemoveTriggerConfig).toHaveBeenCalledWith('test-system', OPENCLAW_ROOT);

      // Should remove MCP config dir
      expect(fs.rm).toHaveBeenCalledWith(
        path.join(OPENCLAW_ROOT, 'config', 'mcp', 'test-system'),
        { recursive: true, force: true }
      );

      // Should remove agent system dir
      expect(fs.rm).toHaveBeenCalledWith(
        path.join(OPENCLAW_ROOT, 'agents', 'test-system'),
        { recursive: true, force: true }
      );
    });

    it('cleans up only completed steps when trigger config fails', async () => {
      setupHappyPath();
      mockCreateTriggerConfig.mockRejectedValue(new Error('trigger write failed'));
      const bundle = createTestBundle();

      await expect(deploySystem(bundle, OPENCLAW_ROOT)).rejects.toThrow(DeployError);

      // Should NOT try to update registry (never registered)
      expect(mockUpdateSystemStatus).not.toHaveBeenCalled();

      // Should NOT try to remove trigger config (it failed to create)
      expect(mockRemoveTriggerConfig).not.toHaveBeenCalled();

      // Should clean up MCP config dir (step 2 succeeded)
      expect(fs.rm).toHaveBeenCalledWith(
        path.join(OPENCLAW_ROOT, 'config', 'mcp', 'test-system'),
        { recursive: true, force: true }
      );

      // Should clean up agent dir (step 1 succeeded)
      expect(fs.rm).toHaveBeenCalledWith(
        path.join(OPENCLAW_ROOT, 'agents', 'test-system'),
        { recursive: true, force: true }
      );
    });

    it('cleans up only agent dir when MCP config write fails', async () => {
      // Make step 2 (writeMcpConfigs) fail by having mkdir succeed but writeFile fail for MCP
      setupHappyPath();
      (fs.mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
      let writeCount = 0;
      (fs.writeFile as ReturnType<typeof vi.fn>).mockImplementation((filePath: string) => {
        writeCount++;
        // First writes are CLAUDE.md files (step 1), then MCP configs (step 2)
        if ((filePath as string).includes('/config/mcp/')) {
          return Promise.reject(new Error('disk full'));
        }
        return Promise.resolve(undefined);
      });
      const bundle = createTestBundle();

      await expect(deploySystem(bundle, OPENCLAW_ROOT)).rejects.toThrow(DeployError);

      // Registry and trigger should not be cleaned up (never created)
      expect(mockUpdateSystemStatus).not.toHaveBeenCalled();
      expect(mockRemoveTriggerConfig).not.toHaveBeenCalled();

      // Agent dir should be cleaned up (step 1 succeeded)
      expect(fs.rm).toHaveBeenCalledWith(
        path.join(OPENCLAW_ROOT, 'agents', 'test-system'),
        { recursive: true, force: true }
      );
    });

    it('continues cleanup even if individual cleanup steps fail', async () => {
      setupHappyPath();
      // Fail step 3 so artifacts.systemDir and artifacts.mcpConfigDir are
      // both set when rollback runs — exercises two fs.rm calls.
      mockCreateTriggerConfig.mockRejectedValue(new Error('trigger write failed'));
      // Make the first fs.rm throw — the cleanup loop should not bail
      // and should still attempt the second fs.rm call.
      (fs.rm as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
        Promise.reject(new Error('rm failed'))
      );
      const bundle = createTestBundle();

      await expect(deploySystem(bundle, OPENCLAW_ROOT)).rejects.toThrow(DeployError);

      // Both cleanup fs.rm calls should have been attempted despite the
      // first one throwing.
      expect(fs.rm).toHaveBeenCalledTimes(2);
    });

    it('wraps non-DeployError in DeployError', async () => {
      setupHappyPath();
      // Make the trigger-config step throw a non-DeployError — the outer
      // catch should wrap it in DeployError with step='unknown'.
      mockCreateTriggerConfig.mockRejectedValue(new TypeError('something unexpected'));
      const bundle = createTestBundle();

      try {
        await deploySystem(bundle, OPENCLAW_ROOT);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DeployError);
        expect((err as DeployError).step).toBe('unknown');
        expect((err as DeployError).message).toContain('test-system');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Agent CLAUDE.md content
  // ---------------------------------------------------------------------------
  describe('generated CLAUDE.md content', () => {
    it('includes agent name, role, and system slug', async () => {
      setupHappyPath();
      const bundle = createTestBundle();

      await deploySystem(bundle, OPENCLAW_ROOT);

      const writeFileCalls = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls;
      const leadClaudeMd = writeFileCalls.find(
        (c: unknown[]) => (c[0] as string).includes('lead-agent/CLAUDE.md')
      );
      expect(leadClaudeMd).toBeDefined();
      const content = leadClaudeMd![1] as string;
      expect(content).toContain('# Lead Agent');
      expect(content).toContain('System: test-system');
      expect(content).toContain('Role: lead');
    });

    it('includes description, system prompt, provider/model, and MCPs', async () => {
      setupHappyPath();
      const bundle = createTestBundle();

      await deploySystem(bundle, OPENCLAW_ROOT);

      const writeFileCalls = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls;
      const agentClaudeMd = writeFileCalls.find(
        (c: unknown[]) => (c[0] as string).includes('lead-agent/CLAUDE.md')
      );
      const content = agentClaudeMd![1] as string;
      expect(content).toContain('## Description');
      expect(content).toContain('## System Prompt');
      expect(content).toContain('## Model Configuration');
      expect(content).toContain('Provider: anthropic');
      expect(content).toContain('## MCP Servers');
      expect(content).toContain('- filesystem');
      expect(content).toContain('- browser');
    });
  });

  // ---------------------------------------------------------------------------
  // MCP config content
  // ---------------------------------------------------------------------------
  describe('MCP config content', () => {
    it('writes correct JSON with name, command, args, env', async () => {
      setupHappyPath();
      const bundle = createTestBundle();

      await deploySystem(bundle, OPENCLAW_ROOT);

      const writeFileCalls = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls;
      const mcpWrite = writeFileCalls.find(
        (c: unknown[]) => (c[0] as string).endsWith('filesystem.json')
      );
      expect(mcpWrite).toBeDefined();

      const parsed = JSON.parse(mcpWrite![1] as string);
      expect(parsed.name).toBe('filesystem');
      expect(parsed.command).toBe('npx');
      expect(parsed.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem']);
      expect(parsed.env).toEqual({ HOME: '/tmp' });
    });

    it('defaults args and env to empty when not provided', async () => {
      setupHappyPath();
      const bundle = createTestBundle({
        mcpConfigs: [{ name: 'minimal', command: 'run' }],
      });

      await deploySystem(bundle, OPENCLAW_ROOT);

      const writeFileCalls = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls;
      const mcpWrite = writeFileCalls.find(
        (c: unknown[]) => (c[0] as string).endsWith('minimal.json')
      );
      const parsed = JSON.parse(mcpWrite![1] as string);
      expect(parsed.args).toEqual([]);
      expect(parsed.env).toEqual({});
    });
  });
});

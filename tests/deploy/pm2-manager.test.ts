import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PM2AppConfig } from '../../types/registry';

// ---------------------------------------------------------------------------
// Mock the pm2 module before importing pm2-manager
// vi.hoisted runs before vi.mock so the reference is available in the factory
// ---------------------------------------------------------------------------

const mockPm2 = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  delete: vi.fn(),
  describe: vi.fn(),
  list: vi.fn(),
}));

vi.mock('pm2', () => ({ default: mockPm2 }));

import {
  startProcess,
  stopProcess,
  restartProcess,
  deleteProcess,
  getProcessStatus,
  listProcesses,
  PM2Error,
} from '../../services/pm2-manager';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDescription(name: string, status: string, pid = 1234) {
  return {
    name,
    pid,
    pm2_env: { status, pm_uptime: Date.now(), restart_time: 0 },
    monit: { cpu: 1.5, memory: 50_000_000 },
  };
}

const testConfig: PM2AppConfig = {
  name: 'autopilate-test-system',
  script: 'run.js',
  cwd: '/opt/openclaw/agents/test-system',
  interpreter: 'node',
};

describe('PM2 Manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Default: connect succeeds
    mockPm2.connect.mockImplementation((cb: (err?: Error) => void) => cb());
    mockPm2.disconnect.mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // startProcess
  // ---------------------------------------------------------------------------
  describe('startProcess', () => {
    it('calls pm2.start with the provided config', async () => {
      mockPm2.start.mockImplementation((_opts: unknown, cb: (err?: Error, proc?: unknown) => void) => cb(undefined, {}));
      mockPm2.describe.mockImplementation((_name: string, cb: (err?: Error, desc?: unknown[]) => void) => {
        cb(undefined, [makeDescription('autopilate-test-system', 'online')]);
      });

      const promise = startProcess(testConfig);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(mockPm2.start).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'autopilate-test-system', script: 'run.js' }),
        expect.any(Function)
      );
      expect(result.name).toBe('autopilate-test-system');
      expect(result.status).toBe('online');
    });

    it('polls until process reaches online status', async () => {
      mockPm2.start.mockImplementation((_opts: unknown, cb: (err?: Error) => void) => cb());

      let callCount = 0;
      mockPm2.describe.mockImplementation((_name: string, cb: (err?: Error, desc?: unknown[]) => void) => {
        callCount++;
        const status = callCount >= 3 ? 'online' : 'launching';
        cb(undefined, [makeDescription('autopilate-test-system', status)]);
      });

      const promise = startProcess(testConfig);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(callCount).toBeGreaterThanOrEqual(3);
      expect(result.status).toBe('online');
    });

    it('throws PM2Error if process enters errored state', async () => {
      mockPm2.start.mockImplementation((_opts: unknown, cb: (err?: Error) => void) => cb());
      mockPm2.describe.mockImplementation((_name: string, cb: (err?: Error, desc?: unknown[]) => void) => {
        cb(undefined, [makeDescription('autopilate-test-system', 'errored')]);
      });

      const promise = startProcess(testConfig);
      // Attach rejection handler before advancing timers to avoid unhandled rejection
      const assertion = expect(promise).rejects.toThrow(/errored state/);
      await vi.runAllTimersAsync();
      await assertion;
    });

    it('throws PM2Error if pm2.start fails', async () => {
      mockPm2.start.mockImplementation((_opts: unknown, cb: (err?: Error) => void) => {
        cb(new Error('spawn failed'));
      });

      const promise = startProcess(testConfig);
      const assertion = expect(promise).rejects.toThrow(PM2Error);
      await vi.runAllTimersAsync();
      await assertion;
    });

    it('throws PM2Error on poll timeout', async () => {
      mockPm2.start.mockImplementation((_opts: unknown, cb: (err?: Error) => void) => cb());
      mockPm2.describe.mockImplementation((_name: string, cb: (err?: Error, desc?: unknown[]) => void) => {
        cb(undefined, [makeDescription('autopilate-test-system', 'launching')]);
      });

      const promise = startProcess(testConfig);
      const assertion = expect(promise).rejects.toThrow(/did not reach online/);
      await vi.advanceTimersByTimeAsync(16_000);
      await assertion;
    });

    it('always disconnects even on error', async () => {
      mockPm2.start.mockImplementation((_opts: unknown, cb: (err?: Error) => void) => {
        cb(new Error('boom'));
      });

      const promise = startProcess(testConfig);
      const assertion = expect(promise).rejects.toThrow();
      await vi.runAllTimersAsync();
      await assertion;
      expect(mockPm2.disconnect).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // restartProcess
  // ---------------------------------------------------------------------------
  describe('restartProcess', () => {
    it('calls pm2.restart and polls for online', async () => {
      mockPm2.restart.mockImplementation((_name: string, cb: (err?: Error) => void) => cb());
      mockPm2.describe.mockImplementation((_name: string, cb: (err?: Error, desc?: unknown[]) => void) => {
        cb(undefined, [makeDescription('autopilate-test-system', 'online')]);
      });

      const promise = restartProcess('autopilate-test-system');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(mockPm2.restart).toHaveBeenCalledWith('autopilate-test-system', expect.any(Function));
      expect(result.status).toBe('online');
    });

    it('throws on restart failure', async () => {
      mockPm2.restart.mockImplementation((_name: string, cb: (err?: Error) => void) => {
        cb(new Error('restart failed'));
      });

      const promise = restartProcess('autopilate-test-system');
      const assertion = expect(promise).rejects.toThrow(PM2Error);
      await vi.runAllTimersAsync();
      await assertion;
    });
  });

  // ---------------------------------------------------------------------------
  // stopProcess
  // ---------------------------------------------------------------------------
  describe('stopProcess', () => {
    it('calls pm2.stop with the process name', async () => {
      mockPm2.stop.mockImplementation((_name: string, cb: (err?: Error) => void) => cb());

      await stopProcess('autopilate-test-system');

      expect(mockPm2.stop).toHaveBeenCalledWith('autopilate-test-system', expect.any(Function));
    });
  });

  // ---------------------------------------------------------------------------
  // deleteProcess
  // ---------------------------------------------------------------------------
  describe('deleteProcess', () => {
    it('calls pm2.delete with the process name', async () => {
      mockPm2.delete.mockImplementation((_name: string, cb: (err?: Error) => void) => cb());

      await deleteProcess('autopilate-test-system');

      expect(mockPm2.delete).toHaveBeenCalledWith('autopilate-test-system', expect.any(Function));
    });
  });

  // ---------------------------------------------------------------------------
  // getProcessStatus
  // ---------------------------------------------------------------------------
  describe('getProcessStatus', () => {
    it('returns status when process exists', async () => {
      mockPm2.describe.mockImplementation((_name: string, cb: (err?: Error, desc?: unknown[]) => void) => {
        cb(undefined, [makeDescription('autopilate-test-system', 'online', 9876)]);
      });

      const status = await getProcessStatus('autopilate-test-system');

      expect(status).not.toBeNull();
      expect(status!.name).toBe('autopilate-test-system');
      expect(status!.pid).toBe(9876);
      expect(status!.status).toBe('online');
    });

    it('throws PM2Error when process not found', async () => {
      mockPm2.describe.mockImplementation((_name: string, cb: (err?: Error, desc?: unknown[]) => void) => {
        cb(undefined, []);
      });

      await expect(getProcessStatus('nonexistent')).rejects.toThrow(PM2Error);
    });
  });

  // ---------------------------------------------------------------------------
  // listProcesses
  // ---------------------------------------------------------------------------
  describe('listProcesses', () => {
    it('filters to only autopilate- prefixed processes', async () => {
      mockPm2.list.mockImplementation((cb: (err?: Error, list?: unknown[]) => void) => {
        cb(undefined, [
          makeDescription('autopilate-sys-a', 'online'),
          makeDescription('other-process', 'online'),
          makeDescription('autopilate-sys-b', 'stopped'),
        ]);
      });

      const list = await listProcesses();

      expect(list).toHaveLength(2);
      expect(list.map((p) => p.name)).toEqual(['autopilate-sys-a', 'autopilate-sys-b']);
    });
  });

  // ---------------------------------------------------------------------------
  // Connection handling
  // ---------------------------------------------------------------------------
  describe('connection handling', () => {
    it('throws PM2Error when connect fails', async () => {
      mockPm2.connect.mockImplementation((cb: (err?: Error) => void) => {
        cb(new Error('daemon not running'));
      });
      mockPm2.stop.mockImplementation((_name: string, cb: (err?: Error) => void) => cb());

      await expect(stopProcess('anything')).rejects.toThrow(PM2Error);
    });
  });
});

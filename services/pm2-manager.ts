// =============================================================================
// PM2 Process Manager Service
// Wraps PM2's programmatic API with promise-based functions and status polling
// =============================================================================

import pm2 from 'pm2';
import { PM2AppConfig } from '../types/registry';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ProcessStatus {
  name: string;
  pid: number | undefined;
  status: string;
  cpu: number;
  memory: number;
  uptime: number | undefined;
  restarts: number;
}

import { PM2ProcessError } from '../lib/errors';

// Re-export for backward compat
export { PM2ProcessError as PM2Error };

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 15_000;

// -----------------------------------------------------------------------------
// Internal: PM2 connection lifecycle
// -----------------------------------------------------------------------------

function connectPm2(): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) reject(new PM2ProcessError('Failed to connect to PM2 daemon', undefined, err));
      else resolve();
    });
  });
}

function disconnectPm2(): void {
  pm2.disconnect();
}

/**
 * Execute a callback within a PM2 connection, ensuring disconnect on completion.
 */
async function withPm2<T>(fn: () => Promise<T>): Promise<T> {
  await connectPm2();
  try {
    return await fn();
  } finally {
    disconnectPm2();
  }
}

// -----------------------------------------------------------------------------
// Internal: Promisified PM2 operations
// -----------------------------------------------------------------------------

function pm2Start(config: PM2AppConfig): Promise<pm2.Proc> {
  return new Promise((resolve, reject) => {
    pm2.start(config as unknown as pm2.StartOptions, (err, proc) => {
      if (err) reject(new PM2ProcessError(`Failed to start process: ${config.name}`, config.name, err));
      else resolve(proc as unknown as pm2.Proc);
    });
  });
}

function pm2Stop(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.stop(name, (err) => {
      if (err) reject(new PM2ProcessError(`Failed to stop process: ${name}`, name, err));
      else resolve();
    });
  });
}

function pm2Delete(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.delete(name, (err) => {
      if (err) reject(new PM2ProcessError(`Failed to delete process: ${name}`, name, err));
      else resolve();
    });
  });
}

function pm2Restart(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2.restart(name, (err) => {
      if (err) reject(new PM2ProcessError(`Failed to restart process: ${name}`, name, err));
      else resolve();
    });
  });
}

function pm2Describe(name: string): Promise<pm2.ProcessDescription[]> {
  return new Promise((resolve, reject) => {
    pm2.describe(name, (err, descriptions) => {
      if (err) reject(new PM2ProcessError(`Failed to describe process: ${name}`, name, err));
      else resolve(descriptions);
    });
  });
}

function pm2List(): Promise<pm2.ProcessDescription[]> {
  return new Promise((resolve, reject) => {
    pm2.list((err, list) => {
      if (err) reject(new PM2ProcessError('Failed to list PM2 processes', undefined, err));
      else resolve(list);
    });
  });
}

// -----------------------------------------------------------------------------
// Internal: Status polling
// -----------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForOnline(name: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const descriptions = await pm2Describe(name);
    const proc = descriptions[0];

    if (proc?.pm2_env?.status === 'online') {
      return;
    }

    if (proc?.pm2_env?.status === 'errored') {
      throw new PM2ProcessError(
        `Process entered errored state: ${name}`,
        name
      );
    }

    await delay(POLL_INTERVAL_MS);
  }

  throw new PM2ProcessError(
    `Process did not reach online status within ${POLL_TIMEOUT_MS}ms: ${name}`,
    name
  );
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Start a PM2 process from an app config and wait until it reaches 'online'.
 */
export async function startProcess(config: PM2AppConfig): Promise<ProcessStatus> {
  return withPm2(async () => {
    await pm2Start(config);
    await pollForOnline(config.name);
    return getProcessStatusInternal(config.name);
  });
}

/**
 * Stop a running PM2 process by name.
 */
export async function stopProcess(name: string): Promise<void> {
  return withPm2(async () => {
    await pm2Stop(name);
  });
}

/**
 * Restart a PM2 process and wait until it reaches 'online'.
 */
export async function restartProcess(name: string): Promise<ProcessStatus> {
  return withPm2(async () => {
    await pm2Restart(name);
    await pollForOnline(name);
    return getProcessStatusInternal(name);
  });
}

/**
 * Delete a PM2 process entirely (stop + remove from PM2 list).
 */
export async function deleteProcess(name: string): Promise<void> {
  return withPm2(async () => {
    await pm2Delete(name);
  });
}

/**
 * Get the current status of a PM2 process by name.
 */
export async function getProcessStatus(name: string): Promise<ProcessStatus | null> {
  return withPm2(async () => {
    return getProcessStatusInternal(name);
  });
}

/**
 * List all PM2 processes matching the autopilate prefix.
 */
export async function listProcesses(): Promise<ProcessStatus[]> {
  return withPm2(async () => {
    const list = await pm2List();
    return list
      .filter((proc) => proc.name?.startsWith('autopilate-'))
      .map(descriptionToStatus);
  });
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

async function getProcessStatusInternal(name: string): Promise<ProcessStatus> {
  const descriptions = await pm2Describe(name);
  if (descriptions.length === 0) {
    throw new PM2ProcessError(`Process not found: ${name}`, name);
  }
  return descriptionToStatus(descriptions[0]);
}

function descriptionToStatus(proc: pm2.ProcessDescription): ProcessStatus {
  const env = proc.pm2_env as Record<string, unknown> | undefined;
  return {
    name: proc.name ?? 'unknown',
    pid: proc.pid,
    status: (env?.status as string) ?? 'unknown',
    cpu: (proc.monit?.cpu as number) ?? 0,
    memory: (proc.monit?.memory as number) ?? 0,
    uptime: env?.pm_uptime as number | undefined,
    restarts: (env?.restart_time as number) ?? 0,
  };
}

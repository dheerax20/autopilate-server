import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client, Pool } from 'pg';
import { createTestBundle, createTestManifest } from './fixtures';

// ---------------------------------------------------------------------------
// Skip guard: these tests require a running PostgreSQL instance
// ---------------------------------------------------------------------------

async function isPostgresAvailable(): Promise<boolean> {
  const client = new Client({ connectionString: baseConnectionUrl() });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test database lifecycle
// ---------------------------------------------------------------------------

const TEST_DB_NAME = 'autopilate_test_deploy';
const BASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/postgres';

// Parse out the base connection string (without a specific database)
function baseConnectionUrl(): string {
  const url = new URL(BASE_URL);
  url.pathname = '/postgres';
  return url.toString();
}

function testDbUrl(): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${TEST_DB_NAME}`;
  return url.toString();
}

let testPool: Pool;

async function createTestDatabase(): Promise<void> {
  const client = new Client({ connectionString: baseConnectionUrl() });
  await client.connect();
  try {
    // Drop if exists from a previous failed run
    await client.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await client.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  } finally {
    await client.end();
  }
}

async function dropTestDatabase(): Promise<void> {
  const client = new Client({ connectionString: baseConnectionUrl() });
  await client.connect();
  try {
    // Terminate active connections
    await client.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid()
    `);
    await client.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
  } finally {
    await client.end();
  }
}

async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Run the initial schema migration directly
    await client.query(`
      CREATE TABLE IF NOT EXISTS deployments (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        system_name     varchar(255) NOT NULL,
        system_slug     varchar(128) UNIQUE NOT NULL,
        manifest_json   jsonb,
        canvas_json     jsonb,
        openclaw_config jsonb,
        trigger_type    varchar(50),
        trigger_config  jsonb,
        pm2_process_name varchar(128),
        status          varchar(20) DEFAULT 'deployed',
        secrets_encrypted bytea,
        deployed_at     timestamptz DEFAULT now(),
        created_at      timestamptz DEFAULT now(),
        updated_at      timestamptz DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS execution_logs (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        deployment_id     uuid NOT NULL REFERENCES deployments(id),
        triggered_by      varchar(50),
        trigger_input     jsonb,
        status            varchar(20),
        phases_completed  int,
        phases_total      int,
        output_url        text,
        output_type       varchar(50),
        cost_usd          decimal(10,4),
        duration_seconds  int,
        qa_scores         jsonb,
        error_message     text,
        started_at        timestamptz,
        completed_at      timestamptz
      );

      CREATE INDEX IF NOT EXISTS idx_execution_logs_deployment_id
        ON execution_logs (deployment_id);

      CREATE TABLE IF NOT EXISTS operator_actions (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        deployment_id   uuid REFERENCES deployments(id),
        operator_type   varchar(30),
        action_type     varchar(50),
        description     text,
        before_state    jsonb,
        after_state     jsonb,
        auto_applied    boolean DEFAULT false,
        approved        boolean,
        created_at      timestamptz DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_operator_actions_deployment_id
        ON operator_actions (deployment_id);
    `);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Dynamic import of registry with overridden pool
// ---------------------------------------------------------------------------

// We need to override the pool used by registry.ts. We do this by mocking
// the db module to return our test pool.

import { vi } from 'vitest';

// We'll set up the mock before importing registry
let registerSystem: typeof import('../../services/registry').registerSystem;
let getSystem: typeof import('../../services/registry').getSystem;
let listSystems: typeof import('../../services/registry').listSystems;
let updateSystemStatus: typeof import('../../services/registry').updateSystemStatus;
let archiveSystem: typeof import('../../services/registry').archiveSystem;
let SystemNotFoundError: typeof import('../../services/registry').SystemNotFoundError;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let pgAvailable = false;

describe('Registry Integration Tests', () => {
  beforeAll(async () => {
    pgAvailable = await isPostgresAvailable();
    if (!pgAvailable) {
      return;
    }

    // encryptSecrets requires ENCRYPTION_KEY (32 bytes hex = 64 chars)
    if (!process.env.ENCRYPTION_KEY) {
      process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    }

    await createTestDatabase();
    testPool = new Pool({ connectionString: testDbUrl() });
    await runMigrations(testPool);

    // Mock the db module to use our test pool
    vi.doMock('../../db', () => ({
      pool: testPool,
    }));

    // Dynamically import registry after mocking
    const registry = await import('../../services/registry');
    registerSystem = registry.registerSystem;
    getSystem = registry.getSystem;
    listSystems = registry.listSystems;
    updateSystemStatus = registry.updateSystemStatus;
    archiveSystem = registry.archiveSystem;
    SystemNotFoundError = registry.SystemNotFoundError;
  }, 30_000);

  afterAll(async () => {
    if (testPool) {
      await testPool.end();
    }
    if (pgAvailable) {
      await dropTestDatabase();
    }
    vi.restoreAllMocks();
  }, 30_000);

  beforeEach(async (ctx) => {
    if (!pgAvailable) {
      ctx.skip();
      return;
    }
    // Clean up deployments between tests (cascade not needed since we don't insert children)
    await testPool.query('DELETE FROM operator_actions');
    await testPool.query('DELETE FROM execution_logs');
    await testPool.query('DELETE FROM deployments');
  });

  // ---------------------------------------------------------------------------
  // registerSystem
  // ---------------------------------------------------------------------------
  describe('registerSystem', () => {
    it('inserts a deployment record and returns it', async () => {
      const bundle = createTestBundle();
      const record = await registerSystem(bundle);

      expect(record.id).toBeDefined();
      expect(record.systemName).toBe('Test System');
      expect(record.systemSlug).toBe('test-system');
      expect(record.pm2ProcessName).toBe('autopilate-test-system');
      expect(record.status).toBe('deployed');
      expect(record.triggerType).toBe('cron');
      expect(record.manifestJson).toBeDefined();
    });

    it('stores manifest and canvas as jsonb', async () => {
      const bundle = createTestBundle();
      const record = await registerSystem(bundle);

      // Query directly to verify jsonb storage
      const { rows } = await testPool.query(
        'SELECT manifest_json, canvas_json FROM deployments WHERE id = $1',
        [record.id]
      );
      expect(rows[0].manifest_json.name).toBe('Test System');
      expect(rows[0].canvas_json).toEqual({ nodes: [], edges: [] });
    });

    it('rejects duplicate slugs', async () => {
      const bundle = createTestBundle();
      await registerSystem(bundle);

      await expect(registerSystem(bundle)).rejects.toThrow();
    });

    it('sets deployed_at timestamp', async () => {
      const bundle = createTestBundle();
      const record = await registerSystem(bundle);

      expect(record.deployedAt).toBeDefined();
      const deployedAt = new Date(record.deployedAt);
      expect(deployedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });
  });

  // ---------------------------------------------------------------------------
  // getSystem
  // ---------------------------------------------------------------------------
  describe('getSystem', () => {
    it('returns the deployment record by slug', async () => {
      const bundle = createTestBundle();
      await registerSystem(bundle);

      const record = await getSystem('test-system');
      expect(record).not.toBeNull();
      expect(record!.systemSlug).toBe('test-system');
      expect(record!.status).toBe('deployed');
    });

    it('returns null for non-existent slug', async () => {
      const record = await getSystem('nonexistent');
      expect(record).toBeNull();
    });

    it('excludes archived systems', async () => {
      const bundle = createTestBundle();
      await registerSystem(bundle);
      await archiveSystem('test-system');

      const record = await getSystem('test-system');
      expect(record).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // listSystems
  // ---------------------------------------------------------------------------
  describe('listSystems', () => {
    it('returns all non-archived systems ordered by created_at DESC', async () => {
      const bundle1 = createTestBundle({
        manifest: createTestManifest({ name: 'System A', slug: 'sys-a' }),
      });
      const bundle2 = createTestBundle({
        manifest: createTestManifest({ name: 'System B', slug: 'sys-b' }),
      });

      await registerSystem(bundle1);
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 50));
      await registerSystem(bundle2);

      const list = await listSystems();
      expect(list).toHaveLength(2);
      // Most recent first
      expect(list[0].systemSlug).toBe('sys-b');
      expect(list[1].systemSlug).toBe('sys-a');
    });

    it('excludes archived systems', async () => {
      const bundle1 = createTestBundle({
        manifest: createTestManifest({ name: 'Active', slug: 'active' }),
      });
      const bundle2 = createTestBundle({
        manifest: createTestManifest({ name: 'Archived', slug: 'archived-sys' }),
      });

      await registerSystem(bundle1);
      await registerSystem(bundle2);
      await archiveSystem('archived-sys');

      const list = await listSystems();
      expect(list).toHaveLength(1);
      expect(list[0].systemSlug).toBe('active');
    });

    it('returns empty array when no systems exist', async () => {
      const list = await listSystems();
      expect(list).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // updateSystemStatus
  // ---------------------------------------------------------------------------
  describe('updateSystemStatus', () => {
    it('updates the status of an existing system', async () => {
      const bundle = createTestBundle();
      await registerSystem(bundle);

      await updateSystemStatus('test-system', 'stopped');

      const record = await getSystem('test-system');
      expect(record!.status).toBe('stopped');
    });

    it('updates the updated_at timestamp', async () => {
      const bundle = createTestBundle();
      const original = await registerSystem(bundle);

      await new Promise((r) => setTimeout(r, 50));
      await updateSystemStatus('test-system', 'errored');

      const updated = await getSystem('test-system');
      expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThan(
        new Date(original.updatedAt).getTime()
      );
    });

    it('throws SystemNotFoundError for nonexistent slug', async () => {
      await expect(
        updateSystemStatus('nonexistent', 'stopped')
      ).rejects.toThrow(SystemNotFoundError);
    });

    it('throws SystemNotFoundError for archived systems', async () => {
      const bundle = createTestBundle();
      await registerSystem(bundle);
      await archiveSystem('test-system');

      await expect(
        updateSystemStatus('test-system', 'stopped')
      ).rejects.toThrow(SystemNotFoundError);
    });
  });

  // ---------------------------------------------------------------------------
  // archiveSystem
  // ---------------------------------------------------------------------------
  describe('archiveSystem', () => {
    it('soft-deletes by setting status to archived', async () => {
      const bundle = createTestBundle();
      await registerSystem(bundle);

      await archiveSystem('test-system');

      // Direct query to confirm status
      const { rows } = await testPool.query(
        "SELECT status FROM deployments WHERE system_slug = 'test-system'"
      );
      expect(rows[0].status).toBe('archived');
    });

    it('throws SystemNotFoundError for nonexistent slug', async () => {
      await expect(archiveSystem('nonexistent')).rejects.toThrow(SystemNotFoundError);
    });

    it('throws SystemNotFoundError if already archived', async () => {
      const bundle = createTestBundle();
      await registerSystem(bundle);
      await archiveSystem('test-system');

      await expect(archiveSystem('test-system')).rejects.toThrow(SystemNotFoundError);
    });
  });
});

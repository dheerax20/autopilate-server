import { Client } from 'pg';

/**
 * deployments.tags — free-form labels for cross-cutting organization.
 * Domain is the primary grouping axis (one system in one department); tags
 * handle secondary concerns like `status:production`, `owner:reed`,
 * `cost:high`. Multi-valued, queryable via GIN.
 */
export async function up(client: Client): Promise<void> {
  await client.query(`
    ALTER TABLE deployments
      ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_deployments_tags
      ON deployments USING gin (tags)
  `);
}

export async function down(client: Client): Promise<void> {
  await client.query(`DROP INDEX IF EXISTS idx_deployments_tags`);
  await client.query(`ALTER TABLE deployments DROP COLUMN IF EXISTS tags`);
}

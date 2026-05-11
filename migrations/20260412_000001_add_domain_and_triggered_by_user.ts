import { Client } from 'pg';

/**
 * Adds two columns:
 *
 * 1. deployments.domain — groups systems under a supervisor domain.
 *    When set, the Slack bot's router only considers systems in that
 *    domain when a message arrives from the domain's mapped channel.
 *    NULL means "visible to all supervisors" (backward compat).
 *
 * 2. execution_logs.triggered_by_user — records which user triggered
 *    the execution (e.g., Slack user ID). Was missing from the schema
 *    but referenced by slack-bot.ts INSERT — fixed at runtime via
 *    ALTER TABLE during the Tier 3 live test; this migration makes
 *    it permanent and repeatable.
 */
export async function up(client: Client): Promise<void> {
  await client.query(`
    ALTER TABLE deployments
      ADD COLUMN IF NOT EXISTS domain text;

    CREATE INDEX IF NOT EXISTS idx_deployments_domain
      ON deployments (domain)
      WHERE domain IS NOT NULL;

    ALTER TABLE execution_logs
      ADD COLUMN IF NOT EXISTS triggered_by_user text;
  `);
}

export async function down(client: Client): Promise<void> {
  await client.query(`
    DROP INDEX IF EXISTS idx_deployments_domain;

    ALTER TABLE deployments
      DROP COLUMN IF EXISTS domain;

    ALTER TABLE execution_logs
      DROP COLUMN IF EXISTS triggered_by_user;
  `);
}

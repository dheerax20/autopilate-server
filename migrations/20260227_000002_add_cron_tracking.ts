import { Client } from 'pg';

export async function up(client: Client): Promise<void> {
  await client.query(`
    ALTER TABLE deployments ADD COLUMN IF NOT EXISTS cron_last_ran_at TIMESTAMPTZ;
    ALTER TABLE deployments ADD COLUMN IF NOT EXISTS cron_next_run_at TIMESTAMPTZ;
  `);
}

export async function down(client: Client): Promise<void> {
  await client.query(`
    ALTER TABLE deployments DROP COLUMN IF EXISTS cron_next_run_at;
    ALTER TABLE deployments DROP COLUMN IF EXISTS cron_last_ran_at;
  `);
}

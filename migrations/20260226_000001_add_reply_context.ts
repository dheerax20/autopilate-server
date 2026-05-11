import { Client } from 'pg';

export async function up(client: Client): Promise<void> {
  await client.query(`
    ALTER TABLE execution_logs
      ADD COLUMN reply_context jsonb,
      ADD COLUMN reply_sent_at timestamptz,
      ADD COLUMN reply_error text;
  `);
}

export async function down(client: Client): Promise<void> {
  await client.query(`
    ALTER TABLE execution_logs
      DROP COLUMN IF EXISTS reply_context,
      DROP COLUMN IF EXISTS reply_sent_at,
      DROP COLUMN IF EXISTS reply_error;
  `);
}

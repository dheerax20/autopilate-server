import { Client } from 'pg';

/**
 * Custom discover items — AI-generated marketplace entries that live alongside
 * the hardcoded DISCOVER_CATALOG. When a user describes an MCP/skill/prompt
 * they want and clicks "Generate with Claude", the result lands here so it
 * persists across restarts and shows up in the picker for everyone.
 *
 * Same write pattern as custom_provider_definitions: upsert by id, server-side
 * cache stays in sync via the discover-store helper.
 */
export async function up(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS custom_discover_items (
      id TEXT PRIMARY KEY,
      definition JSONB NOT NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function down(client: Client): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS custom_discover_items`);
}

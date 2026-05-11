import { Client } from 'pg';

/**
 * Custom provider definitions — generated on the fly when a user adds a
 * credential for a service not in the hardcoded PROVIDER_CATALOG. The Configure
 * Wizard / Vault dashboard sends a one-line description to Claude, which returns
 * a ProviderDefinition JSON, and the server upserts it here. The catalog
 * endpoint merges this table on top of the hardcoded list so every client sees
 * the same picker.
 *
 * Keyed by id (the kebab-case provider slug); credentials.provider FKs loosely
 * against this + the hardcoded list via the provider-registry helper.
 */
export async function up(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS custom_provider_definitions (
      id TEXT PRIMARY KEY,
      definition JSONB NOT NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function down(client: Client): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS custom_provider_definitions`);
}

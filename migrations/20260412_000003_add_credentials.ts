import { Client } from 'pg';

/**
 * Credential vault — shared storage for API keys, OAuth tokens, MCP configs,
 * and text references that agents and systems need. Values are encrypted
 * at rest with the same ENCRYPTION_KEY the deployments.secrets_encrypted
 * column uses.
 *
 * Lookup flow: when the fixer identifies a needed capability (e.g.,
 * web-search), the Configure Wizard searches this table by provider. If a
 * matching credential exists, it's auto-populated. Otherwise the user is
 * prompted with a typed form, and the submitted value lands here for
 * future reuse.
 *
 * org_id is hedge-columned for future multi-tenancy — defaults to 'default'.
 */
export async function up(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS credentials (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

      -- Identity
      org_id TEXT NOT NULL DEFAULT 'default',
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      credential_type TEXT NOT NULL,

      -- Encrypted payload (JSON string encrypted with ENCRYPTION_KEY,
      -- stored as base64 text — same format as deployments.secrets_encrypted)
      encrypted_value TEXT NOT NULL,

      -- Discovery + metadata
      tags TEXT[] NOT NULL DEFAULT '{}',
      env_var_name TEXT,
      description TEXT,

      -- Usage + validation tracking
      used_by_systems TEXT[] NOT NULL DEFAULT '{}',
      last_validated_at TIMESTAMPTZ,
      last_validation_status TEXT,
      last_used_at TIMESTAMPTZ,

      -- Ownership
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

      UNIQUE (org_id, provider, name)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_credentials_org_provider
      ON credentials (org_id, provider)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_credentials_tags
      ON credentials USING gin (tags)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_credentials_last_used
      ON credentials (last_used_at DESC NULLS LAST)
  `);
}

export async function down(client: Client): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS credentials`);
}

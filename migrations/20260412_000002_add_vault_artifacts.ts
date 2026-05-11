import { Client } from 'pg';

export async function up(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS vault_artifacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      system_slug TEXT NOT NULL,
      execution_id TEXT,
      agent_label TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      metadata JSONB NOT NULL DEFAULT '{}',
      search_vector tsvector,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vault_artifacts_search
      ON vault_artifacts USING gin (search_vector)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vault_artifacts_system
      ON vault_artifacts (system_slug)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_vault_artifacts_tags
      ON vault_artifacts USING gin (tags)
  `);

  // pgvector: optional — graceful if extension not installed
  try {
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await client.query(`
      ALTER TABLE vault_artifacts
        ADD COLUMN IF NOT EXISTS embedding vector(1536)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vault_artifacts_embedding
        ON vault_artifacts USING hnsw (embedding vector_cosine_ops)
    `);
    console.log('[migration] pgvector installed — vault has semantic search');
  } catch {
    console.warn('[migration] pgvector not available — vault uses keyword search only');
  }
}

export async function down(client: Client): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS vault_artifacts`);
}

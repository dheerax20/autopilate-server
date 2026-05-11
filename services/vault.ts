// =============================================================================
// Vault Service — persistent cross-execution artifact storage
//
// Agents write artifacts during execution (via vault-mcp tools) and read
// prior artifacts at the start of subsequent executions. Dual search:
// tsvector for keyword/tag queries, pgvector for semantic similarity.
//
// Embeddings are computed at write time via OpenAI text-embedding-3-large
// (1536 dimensions). Falls back gracefully if OPENAI_API_KEY is not set —
// artifacts are stored without embeddings and only tsvector search works.
// =============================================================================

import { pool } from '../db';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface VaultArtifact {
  id: string;
  systemSlug: string;
  executionId: string | null;
  agentLabel: string;
  title: string;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface VaultStoreInput {
  systemSlug: string;
  executionId?: string;
  agentLabel: string;
  title: string;
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface VaultSearchOptions {
  query: string;
  systemSlug?: string;
  tags?: string[];
  limit?: number;
  mode?: 'semantic' | 'keyword' | 'hybrid';
}

interface VaultSearchResult extends VaultArtifact {
  score: number;
}

// -----------------------------------------------------------------------------
// Embedding
// -----------------------------------------------------------------------------

let embeddingAvailable: boolean | null = null;

async function computeEmbedding(text: string): Promise<number[] | null> {
  // Lazy check — only test once
  if (embeddingAvailable === false) return null;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    if (embeddingAvailable === null) {
      console.log('[vault] OPENAI_API_KEY not set — vault will use keyword search only (no embeddings)');
      embeddingAvailable = false;
    }
    return null;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: text.slice(0, 30000), // ~8K tokens max safety cap
        model: 'text-embedding-3-large',
        dimensions: 1536,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.warn(`[vault] Embedding API error ${response.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };
    embeddingAvailable = true;
    return data.data[0]?.embedding ?? null;
  } catch (err) {
    console.warn('[vault] Embedding request failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

// -----------------------------------------------------------------------------
// Write
// -----------------------------------------------------------------------------

export async function vaultStore(input: VaultStoreInput): Promise<VaultArtifact> {
  const embeddingText = `${input.title}\n\n${input.content}`;
  const embedding = await computeEmbedding(embeddingText);

  // Build tsvector at write time (not a GENERATED column because the
  // pg client's transaction-wrapped DDL doesn't reliably support
  // GENERATED ALWAYS AS with to_tsvector). Compute it server-side
  // via to_tsvector() in the INSERT so Postgres does the tokenization.
  const hasEmbeddingCol = embedding !== null;

  const { rows } = await pool.query<{
    id: string;
    created_at: string;
  }>(
    hasEmbeddingCol
      ? `INSERT INTO vault_artifacts (
           system_slug, execution_id, agent_label, title, content, tags, metadata,
           search_vector, embedding
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::jsonb,
           to_tsvector('english', $4 || ' ' || $5),
           $8::vector
         )
         RETURNING id, created_at`
      : `INSERT INTO vault_artifacts (
           system_slug, execution_id, agent_label, title, content, tags, metadata,
           search_vector
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::jsonb,
           to_tsvector('english', $4 || ' ' || $5)
         )
         RETURNING id, created_at`,
    hasEmbeddingCol
      ? [
          input.systemSlug,
          input.executionId ?? null,
          input.agentLabel,
          input.title,
          input.content,
          input.tags ?? [],
          JSON.stringify(input.metadata ?? {}),
          toVectorLiteral(embedding!),
        ]
      : [
          input.systemSlug,
          input.executionId ?? null,
          input.agentLabel,
          input.title,
          input.content,
          input.tags ?? [],
          JSON.stringify(input.metadata ?? {}),
        ]
  );

  return {
    id: rows[0].id,
    systemSlug: input.systemSlug,
    executionId: input.executionId ?? null,
    agentLabel: input.agentLabel,
    title: input.title,
    content: input.content,
    tags: input.tags ?? [],
    metadata: input.metadata ?? {},
    createdAt: rows[0].created_at,
  };
}

// -----------------------------------------------------------------------------
// Read
// -----------------------------------------------------------------------------

export async function vaultGet(id: string): Promise<VaultArtifact | null> {
  const { rows } = await pool.query<VaultRow>(
    `SELECT id, system_slug, execution_id, agent_label, title, content,
            tags, metadata, created_at
     FROM vault_artifacts WHERE id = $1`,
    [id]
  );
  return rows.length > 0 ? rowToArtifact(rows[0]) : null;
}

export async function vaultListByTag(
  tag: string,
  systemSlug?: string,
  limit: number = 20
): Promise<VaultArtifact[]> {
  const conditions = ['$1 = ANY(tags)'];
  const params: unknown[] = [tag];

  if (systemSlug) {
    conditions.push(`system_slug = $${params.length + 1}`);
    params.push(systemSlug);
  }

  params.push(limit);
  const { rows } = await pool.query<VaultRow>(
    `SELECT id, system_slug, execution_id, agent_label, title, content,
            tags, metadata, created_at
     FROM vault_artifacts
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );

  return rows.map(rowToArtifact);
}

// -----------------------------------------------------------------------------
// Search (hybrid: tsvector + pgvector)
// -----------------------------------------------------------------------------

export async function vaultSearch(
  options: VaultSearchOptions
): Promise<VaultSearchResult[]> {
  const { query, systemSlug, tags, limit = 10, mode = 'hybrid' } = options;

  // Decide search strategy
  const useVector = mode !== 'keyword';
  const useKeyword = mode !== 'semantic';

  let embedding: number[] | null = null;
  if (useVector) {
    embedding = await computeEmbedding(query);
  }

  // If we wanted vector but couldn't get an embedding, fall back to keyword
  const hasEmbedding = embedding !== null;
  const doVector = useVector && hasEmbedding;
  const doKeyword = useKeyword || !doVector;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  // System filter
  if (systemSlug) {
    conditions.push(`system_slug = $${paramIdx}`);
    params.push(systemSlug);
    paramIdx++;
  }

  // Tag filter
  if (tags && tags.length > 0) {
    conditions.push(`tags && $${paramIdx}`);
    params.push(tags);
    paramIdx++;
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  if (doVector && doKeyword) {
    // Hybrid: combine vector similarity and tsvector rank
    const vectorParam = paramIdx++;
    const tsParam = paramIdx++;
    const limitParam = paramIdx;
    params.push(toVectorLiteral(embedding!), query, limit);

    const { rows } = await pool.query<VaultRow & { score: number }>(
      `SELECT *,
              (0.6 * (1 - (embedding <=> $${vectorParam}::vector)) +
               0.4 * ts_rank(search_vector, plainto_tsquery('english', $${tsParam}))
              ) AS score
       FROM vault_artifacts
       ${whereClause}${whereClause ? ' AND' : 'WHERE'} embedding IS NOT NULL
       ORDER BY score DESC
       LIMIT $${limitParam}`,
      params
    );
    return rows.map((r) => ({ ...rowToArtifact(r), score: r.score }));
  }

  if (doVector) {
    // Vector-only
    const vectorParam = paramIdx++;
    const limitParam = paramIdx;
    params.push(toVectorLiteral(embedding!), limit);

    const { rows } = await pool.query<VaultRow & { score: number }>(
      `SELECT *,
              (1 - (embedding <=> $${vectorParam}::vector)) AS score
       FROM vault_artifacts
       ${whereClause}${whereClause ? ' AND' : 'WHERE'} embedding IS NOT NULL
       ORDER BY embedding <=> $${vectorParam}::vector
       LIMIT $${limitParam}`,
      params
    );
    return rows.map((r) => ({ ...rowToArtifact(r), score: r.score }));
  }

  // Keyword-only
  const tsParam = paramIdx++;
  const limitParam = paramIdx;
  params.push(query, limit);

  const { rows } = await pool.query<VaultRow & { score: number }>(
    `SELECT *,
            ts_rank(search_vector, plainto_tsquery('english', $${tsParam})) AS score
     FROM vault_artifacts
     ${whereClause}${whereClause ? ' AND' : 'WHERE'}
       search_vector @@ plainto_tsquery('english', $${tsParam})
     ORDER BY score DESC
     LIMIT $${limitParam}`,
    params
  );
  return rows.map((r) => ({ ...rowToArtifact(r), score: r.score }));
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface VaultRow {
  id: string;
  system_slug: string;
  execution_id: string | null;
  agent_label: string;
  title: string;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: string;
}

function rowToArtifact(row: VaultRow): VaultArtifact {
  return {
    id: row.id,
    systemSlug: row.system_slug,
    executionId: row.execution_id,
    agentLabel: row.agent_label,
    title: row.title,
    content: row.content,
    tags: row.tags,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

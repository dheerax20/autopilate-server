// =============================================================================
// Custom Provider Store
//
// Holds AI-generated ProviderDefinitions that live alongside the hardcoded
// PROVIDER_CATALOG. Values are loaded from Postgres once at server startup
// and cached in memory so getProvider lookups can stay synchronous (the
// credential-vault and deploy-bridge code paths rely on that).
//
// Write path: upsertCustomProvider() persists to the DB AND updates the
// in-memory map, so newly generated providers are immediately visible to
// subsequent requests without another DB round-trip.
// =============================================================================

import { pool } from '../db';
import type { ProviderDefinition } from './credential-catalog';

interface CustomProviderRow {
  id: string;
  definition: ProviderDefinition;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const customProviders = new Map<string, ProviderDefinition>();
let loaded = false;

/**
 * Populate the in-memory cache from the DB. Call once at server startup,
 * before any request handlers run.
 */
export async function loadCustomProviders(): Promise<void> {
  const { rows } = await pool.query<CustomProviderRow>(
    `SELECT id, definition, created_by, created_at, updated_at
     FROM custom_provider_definitions`
  );
  customProviders.clear();
  for (const row of rows) {
    customProviders.set(row.id, row.definition);
  }
  loaded = true;
  console.log(`[custom-providers] Loaded ${customProviders.size} custom provider(s)`);
}

/**
 * Sync lookup. Returns undefined if the id isn't a known custom provider.
 * Callers that want to check both the hardcoded catalog and the custom
 * store should use provider-registry.getProviderAny instead.
 */
export function getCustomProvider(id: string): ProviderDefinition | undefined {
  return customProviders.get(id);
}

/**
 * Sync snapshot of every custom provider. Used by the catalog endpoint to
 * merge custom entries with the hardcoded PROVIDER_CATALOG.
 */
export function listCustomProviders(): ProviderDefinition[] {
  return Array.from(customProviders.values());
}

/**
 * Persist a generated ProviderDefinition and update the in-memory cache.
 * Idempotent: re-upserting with the same id overwrites the existing entry.
 */
export async function upsertCustomProvider(
  definition: ProviderDefinition,
  createdBy?: string
): Promise<ProviderDefinition> {
  await pool.query(
    `INSERT INTO custom_provider_definitions (id, definition, created_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       definition = EXCLUDED.definition,
       updated_at = now()`,
    [definition.id, JSON.stringify(definition), createdBy ?? null]
  );
  customProviders.set(definition.id, definition);
  return definition;
}

/**
 * Test helper / debug. Not called by route handlers — use upsertCustomProvider
 * for the write path so the DB and memory stay in sync.
 */
export function isCustomProviderLoaded(): boolean {
  return loaded;
}

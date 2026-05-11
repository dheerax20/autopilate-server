// =============================================================================
// Discover Store
//
// In-memory cache for AI-generated DiscoverItems. Loaded from
// custom_discover_items at startup so the discover-registry can serve sync
// reads. Same pattern as custom-provider-store.
// =============================================================================

import { pool } from '../db';
import type { DiscoverItem } from './discover-catalog';

interface DiscoverItemRow {
  id: string;
  definition: DiscoverItem;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const customItems = new Map<string, DiscoverItem>();
let loaded = false;

/** Populate the cache from the DB. Call once at server startup. */
export async function loadCustomDiscoverItems(): Promise<void> {
  const { rows } = await pool.query<DiscoverItemRow>(
    `SELECT id, definition, created_by, created_at, updated_at
     FROM custom_discover_items`
  );
  customItems.clear();
  for (const row of rows) {
    customItems.set(row.id, row.definition);
  }
  loaded = true;
  console.log(`[discover-store] Loaded ${customItems.size} custom discover item(s)`);
}

export function getCustomDiscoverItem(id: string): DiscoverItem | undefined {
  return customItems.get(id);
}

export function listCustomDiscoverItems(): DiscoverItem[] {
  return Array.from(customItems.values());
}

/** Persist a generated DiscoverItem and update the in-memory cache. */
export async function upsertCustomDiscoverItem(
  item: DiscoverItem,
  createdBy?: string
): Promise<DiscoverItem> {
  await pool.query(
    `INSERT INTO custom_discover_items (id, definition, created_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       definition = EXCLUDED.definition,
       updated_at = now()`,
    [item.id, JSON.stringify(item), createdBy ?? null]
  );
  customItems.set(item.id, item);
  return item;
}

export function isDiscoverStoreLoaded(): boolean {
  return loaded;
}

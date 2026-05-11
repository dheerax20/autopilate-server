// =============================================================================
// Discover Sync
//
// Runs every source in DISCOVER_SOURCES, fetches its items, and upserts them
// into custom_discover_items. Used by the "Sync from sources" button on the
// Discover dashboard and (optionally) a future scheduled cron job.
//
// Returns a per-source summary: items synced, errors encountered, total time.
// =============================================================================

import { upsertCustomDiscoverItem } from './discover-store';
import { fetchSource } from './discover-fetchers/github-repo';
import { DISCOVER_SOURCES } from './discover-fetchers/sources';

export interface SourceSyncResult {
  sourceId: string;
  sourceName: string;
  itemsSynced: number;
  errors: string[];
  durationMs: number;
}

export interface SyncSummary {
  totalItems: number;
  totalErrors: number;
  totalDurationMs: number;
  sources: SourceSyncResult[];
}

/**
 * Run a sync against every configured source. Sources fail independently —
 * one source failing shouldn't abort the rest.
 */
export async function syncAllSources(): Promise<SyncSummary> {
  const startedAt = Date.now();
  const results: SourceSyncResult[] = [];

  for (const source of DISCOVER_SOURCES) {
    const sourceStartedAt = Date.now();
    let itemsSynced = 0;
    const errors: string[] = [];

    try {
      const { items, errors: fetchErrors } = await fetchSource(source);
      errors.push(...fetchErrors);
      for (const item of items) {
        try {
          await upsertCustomDiscoverItem(item, `sync:${source.id}`);
          itemsSynced++;
        } catch (err) {
          errors.push(
            `${item.id}: persist failed — ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    } catch (err) {
      errors.push(
        `source-level failure: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    results.push({
      sourceId: source.id,
      sourceName: source.name,
      itemsSynced,
      errors,
      durationMs: Date.now() - sourceStartedAt,
    });
  }

  const totalItems = results.reduce((sum, r) => sum + r.itemsSynced, 0);
  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

  console.log(
    `[discover-sync] Synced ${totalItems} item(s) across ${results.length} source(s) ` +
    `with ${totalErrors} error(s) in ${Date.now() - startedAt}ms`
  );

  return {
    totalItems,
    totalErrors,
    totalDurationMs: Date.now() - startedAt,
    sources: results,
  };
}

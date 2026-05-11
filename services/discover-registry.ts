// =============================================================================
// Discover Registry
//
// Single lookup surface that merges DISCOVER_CATALOG (hardcoded) with the
// in-memory custom store. Mirrors the credential provider-registry pattern:
// hardcoded entries win on id collisions, so the curated defaults can't be
// silently overridden by a generated entry with the same slug.
// =============================================================================

import {
  DISCOVER_CATALOG,
  getDiscoverItem as getCatalogItem,
  type DiscoverItem,
} from './discover-catalog';
import {
  getCustomDiscoverItem,
  listCustomDiscoverItems,
} from './discover-store';

export type { DiscoverItem } from './discover-catalog';

/** Resolve a DiscoverItem id against the hardcoded catalog first, then custom. */
export function getDiscoverItemAny(id: string): DiscoverItem | undefined {
  return getCatalogItem(id) ?? getCustomDiscoverItem(id);
}

/** Snapshot of every visible DiscoverItem — hardcoded + custom. */
export function listAllDiscoverItems(): DiscoverItem[] {
  return [...DISCOVER_CATALOG, ...listCustomDiscoverItems()];
}

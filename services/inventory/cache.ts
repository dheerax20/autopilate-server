// =============================================================================
// Inventory Cache — TTL-based caching for expensive directory scans
// Arch review item #12: "Inventory scan results should be cached with TTL"
// =============================================================================

import { InventoryItem } from './types';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  data: InventoryItem[];
  timestamp: number;
}

let cache: CacheEntry | null = null;
let ttlMs: number = parseInt(process.env.INVENTORY_CACHE_TTL_MS || '', 10) || DEFAULT_TTL_MS;

/**
 * Get cached inventory data if it exists and hasn't expired.
 * Returns null if cache is stale or empty.
 */
export function getCachedInventory(): InventoryItem[] | null {
  if (!cache) return null;
  if (Date.now() - cache.timestamp >= ttlMs) {
    cache = null;
    return null;
  }
  return cache.data;
}

/**
 * Store inventory data in the cache with the current timestamp.
 */
export function setCachedInventory(data: InventoryItem[]): void {
  cache = { data, timestamp: Date.now() };
}

/**
 * Invalidate the inventory cache (e.g., when files change).
 */
export function invalidateInventoryCache(): void {
  cache = null;
}

/**
 * Set a custom TTL for the cache (useful for testing).
 */
export function setInventoryCacheTTL(ms: number): void {
  ttlMs = ms;
}

/**
 * Get current cache stats for debugging / health checks.
 */
export function getInventoryCacheStats(): {
  cached: boolean;
  ageMs: number | null;
  ttlMs: number;
} {
  return {
    cached: cache !== null && (Date.now() - cache.timestamp) < ttlMs,
    ageMs: cache ? Date.now() - cache.timestamp : null,
    ttlMs,
  };
}

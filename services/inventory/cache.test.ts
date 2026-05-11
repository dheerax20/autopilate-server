import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedInventory,
  setCachedInventory,
  invalidateInventoryCache,
  setInventoryCacheTTL,
  getInventoryCacheStats,
} from './cache';
import { InventoryItem } from './types';

const mockData: InventoryItem[] = [
  {
    id: 'agents',
    name: 'agents',
    path: 'agents',
    type: 'folder',
    children: [],
  },
];

describe('Inventory Cache', () => {
  beforeEach(() => {
    invalidateInventoryCache();
    setInventoryCacheTTL(5 * 60 * 1000); // reset to default
  });

  it('should return null when cache is empty', () => {
    expect(getCachedInventory()).toBeNull();
  });

  it('should return cached data after set', () => {
    setCachedInventory(mockData);
    const result = getCachedInventory();
    expect(result).toEqual(mockData);
  });

  it('should invalidate cache', () => {
    setCachedInventory(mockData);
    invalidateInventoryCache();
    expect(getCachedInventory()).toBeNull();
  });

  it('should expire after TTL', () => {
    setInventoryCacheTTL(0); // expire immediately
    setCachedInventory(mockData);
    // With TTL=0, the next read should see it as expired
    expect(getCachedInventory()).toBeNull();
  });

  it('should report correct cache stats when empty', () => {
    const stats = getInventoryCacheStats();
    expect(stats.cached).toBe(false);
    expect(stats.ageMs).toBeNull();
  });

  it('should report correct cache stats when populated', () => {
    setCachedInventory(mockData);
    const stats = getInventoryCacheStats();
    expect(stats.cached).toBe(true);
    expect(stats.ageMs).toBeGreaterThanOrEqual(0);
    expect(stats.ageMs!).toBeLessThan(1000);
  });

  it('should report stale cache correctly', () => {
    setInventoryCacheTTL(0);
    setCachedInventory(mockData);
    const stats = getInventoryCacheStats();
    expect(stats.cached).toBe(false);
    expect(stats.ageMs).not.toBeNull();
  });
});

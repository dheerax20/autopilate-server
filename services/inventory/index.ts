// =============================================================================
// Inventory Module — Barrel Export
// =============================================================================

// Types
export type {
  FlattenedItem,
  SearchFacets,
  SearchResult,
  SearchFilters,
  BundleComponent,
  BundleData,
  InventoryItem,
  RepoConfig,
  NestedMcpConfig,
  ComponentInfo,
} from './types';

// Config
export { INVENTORY_ROOT, getInventoryRoot, TYPE_TO_NODE_TYPE } from './config';

// Scanners
export { scanInventory } from './scanners';

// Cache
export { invalidateInventoryCache, getInventoryCacheStats } from './cache';

// Search
export { buildSearchIndex, extractFacets, searchInventory } from './search';

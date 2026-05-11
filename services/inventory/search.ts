// =============================================================================
// Inventory Search Functions
// =============================================================================

import { inferBucketAndSubcategory } from '../bucketInference';
import {
  FlattenedItem,
  SearchFacets,
  SearchResult,
  SearchFilters,
  InventoryItem,
} from './types';
import { TYPE_TO_NODE_TYPE } from './config';

/**
 * Flatten the inventory tree into a searchable list of items
 */
export function buildSearchIndex(inventory: InventoryItem[]): FlattenedItem[] {
  const items: FlattenedItem[] = [];

  function processItem(item: InventoryItem, parentType?: string, parentCategory?: string): void {
    if (item.type === 'file') {
      // File - add to index
      const searchText = [
        item.name,
        item.description || '',
        item.category || '',
        item.repo || '',
      ]
        .join(' ')
        .toLowerCase();

      // Infer capability buckets and subcategories from category, name, and description
      const { buckets, subcategories } = inferBucketAndSubcategory(
        parentCategory || item.category,
        item.name,
        item.description
      );

      items.push({
        id: item.id,
        name: item.name,
        path: item.path,
        nodeType: item.category || parentType || 'AGENT',
        category: item.category,
        description: item.description,
        repo: item.repo,
        searchText,
        isBundle: false,
        buckets,
        subcategories,
      });
    } else if (item.type === 'bundle' && item.bundleData) {
      // Bundle - add bundle itself to index
      const searchText = [
        item.name,
        item.description || item.bundleData.description || '',
        'bundle',
        item.repo || '',
      ]
        .join(' ')
        .toLowerCase();

      // Infer buckets and subcategories for the bundle itself
      const { buckets: bundleBuckets, subcategories: bundleSubcategories } = inferBucketAndSubcategory(
        'bundle',
        item.name,
        item.description || item.bundleData.description
      );

      items.push({
        id: item.id,
        name: item.name,
        path: item.path,
        nodeType: 'BUNDLE',
        category: 'bundle',
        description: item.description || item.bundleData.description,
        repo: item.repo,
        searchText,
        isBundle: true,
        buckets: bundleBuckets,
        subcategories: bundleSubcategories,
      });

      // Also index individual components within the bundle
      const bundleComponents = item.bundleData.components;
      for (const compType of ['agents', 'commands', 'skills', 'hooks'] as const) {
        for (const comp of bundleComponents[compType]) {
          const compSearchText = [
            comp.name,
            comp.description || '',
            compType,
            item.name, // Include bundle name for context
          ]
            .join(' ')
            .toLowerCase();

          // Infer buckets and subcategories for each bundle component
          const { buckets: compBuckets, subcategories: compSubcategories } = inferBucketAndSubcategory(
            comp.category || compType,
            comp.name,
            comp.description
          );

          items.push({
            id: comp.path,
            name: comp.name,
            path: comp.path,
            nodeType: TYPE_TO_NODE_TYPE[compType] || 'AGENT',
            category: compType,
            description: comp.description,
            repo: item.repo,
            searchText: compSearchText,
            isBundle: false,
            buckets: compBuckets,
            subcategories: compSubcategories,
          });
        }
      }
    } else if (item.type === 'folder' && item.children) {
      // Folder - recurse into children
      // Determine node type from folder name if at type level
      const folderType = TYPE_TO_NODE_TYPE[item.name] || parentType;
      // Pass category context (folder name) if it looks like a category folder
      // (not a type folder and not a repo folder)
      const isTypeFolder = TYPE_TO_NODE_TYPE[item.name] !== undefined;
      const folderCategory = !isTypeFolder && parentType ? item.name : parentCategory;
      for (const child of item.children) {
        processItem(child, folderType, folderCategory);
      }
    }
  }

  for (const item of inventory) {
    processItem(item, undefined, undefined);
  }

  return items;
}

/**
 * Extract unique facet values from flattened items
 */
export function extractFacets(items: FlattenedItem[]): SearchFacets {
  const repos = new Set<string>();
  const types = new Set<string>();
  const categories = new Set<string>();
  const buckets = new Set<string>();
  const subcategories = new Set<string>();

  for (const item of items) {
    if (item.repo) repos.add(item.repo);
    if (item.nodeType) types.add(item.nodeType);
    if (item.category) categories.add(item.category);
    if (item.buckets) {
      for (const bucket of item.buckets) {
        buckets.add(bucket);
      }
    }
    if (item.subcategories) {
      for (const subcat of item.subcategories) {
        subcategories.add(subcat);
      }
    }
  }

  return {
    repos: Array.from(repos).sort(),
    types: Array.from(types).sort(),
    categories: Array.from(categories).sort(),
    buckets: Array.from(buckets).sort(),
    subcategories: Array.from(subcategories).sort(),
  };
}

/**
 * Search the flattened inventory index
 */
export function searchInventory(
  index: FlattenedItem[],
  query?: string,
  filters?: SearchFilters,
  options?: { limit?: number; offset?: number }
): SearchResult {
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  // Start with all items
  let results = [...index];

  // Apply text search if query provided
  if (query && query.trim()) {
    const searchTerms = query.toLowerCase().trim().split(/\s+/);
    results = results.filter((item) =>
      searchTerms.every((term) => item.searchText.includes(term))
    );
  }

  // Apply type filter
  if (filters?.types && filters.types.length > 0) {
    const typeSet = new Set(filters.types.map((t) => t.toUpperCase()));
    results = results.filter((item) => typeSet.has(item.nodeType));
  }

  // Apply repo filter
  if (filters?.repos && filters.repos.length > 0) {
    const repoSet = new Set(filters.repos);
    results = results.filter((item) => item.repo && repoSet.has(item.repo));
  }

  // Apply category filter
  if (filters?.categories && filters.categories.length > 0) {
    const categorySet = new Set(filters.categories);
    results = results.filter(
      (item) => item.category && categorySet.has(item.category)
    );
  }

  // Apply bucket filter (OR logic - item matches if ANY of its buckets are in the filter)
  if (filters?.buckets && filters.buckets.length > 0) {
    const bucketSet = new Set(filters.buckets);
    results = results.filter(
      (item) => item.buckets && item.buckets.some((b) => bucketSet.has(b))
    );
  }

  // Apply subcategory filter (requires bucket filter; AND logic between bucket and subcategory)
  // Only applies if bucket filter is also specified
  if (filters?.subcategories && filters.subcategories.length > 0) {
    if (filters?.buckets && filters.buckets.length > 0) {
      const subcatSet = new Set(filters.subcategories);
      results = results.filter((item) => {
        // Check if any of item's (bucket, subcategory) pairs match the filters
        // The bucket must be in the bucket filter AND the subcategory must be in subcategory filter
        return item.buckets.some((bucket, index) => {
          const subcat = item.subcategories[index];
          return filters.buckets!.includes(bucket) && subcatSet.has(subcat);
        });
      });
    } else {
      // If no bucket filter, subcategory filter is ignored (logged as warning)
      console.warn('Subcategory filter specified without bucket filter; ignoring subcategories');
    }
  }

  // Get total before pagination
  const total = results.length;

  // Extract facets from filtered results (before pagination)
  const facets = extractFacets(results);

  // Apply pagination
  const paginatedItems = results.slice(offset, offset + limit);

  return {
    items: paginatedItems,
    facets,
    total,
    limit,
    offset,
  };
}

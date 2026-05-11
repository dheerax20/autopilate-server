// =============================================================================
// Inventory Types
// =============================================================================

export interface FlattenedItem {
  id: string;
  name: string;
  path: string;
  nodeType: string; // AGENT, SKILL, etc.
  category?: string;
  description?: string;
  repo?: string;
  searchText: string; // Pre-computed: name + description + category
  isBundle: boolean;
  buckets: string[]; // Capability bucket IDs (never empty)
  subcategories: string[]; // Parallel array: subcategories[i] for buckets[i]
}

export interface SearchFacets {
  repos: string[];
  types: string[];
  categories: string[];
  buckets: string[]; // Capability bucket IDs
  subcategories: string[]; // All unique subcategories in results
}

export interface SearchResult {
  items: FlattenedItem[];
  facets: SearchFacets;
  total: number;
  limit: number;
  offset: number;
}

export interface SearchFilters {
  types?: string[];
  repos?: string[];
  categories?: string[];
  buckets?: string[]; // Capability bucket IDs (OR within buckets)
  subcategories?: string[]; // Requires bucket filter; AND with bucket, OR within subcategories
}

export interface BundleComponent {
  name: string;
  path: string;
  category: string; // 'agents', 'commands', 'skills', 'hooks'
  description?: string;
}

export interface BundleData {
  description?: string;
  components: {
    agents: BundleComponent[];
    commands: BundleComponent[];
    skills: BundleComponent[];
    hooks: BundleComponent[];
  };
  totalCount: number;
}

export interface InventoryItem {
  id: string;
  name: string;
  path: string;
  type: 'folder' | 'file' | 'bundle';
  category?: string; // 'AGENT', 'SKILL', 'TOOL', etc.
  description?: string;
  repo?: string; // Source repository name
  children?: InventoryItem[];
  bundleData?: BundleData;
}

export interface RepoConfig {
  name: string;
  componentPaths: { type: string; path: string; categoryFromPath?: boolean }[];
}

// MCP configurations for nested structures within 1.MCP-MISC
export interface NestedMcpConfig {
  repoName: string;           // e.g., 'google_workspace_mcp-main'
  subPath: string;            // e.g., '' for root or 'packages' for subdir
  category: string;           // Category for grouping
  pattern?: RegExp;           // Optional pattern to filter subdirs
  descriptionFile?: string;   // File to read description from (default: README.md)
}

export interface ComponentInfo {
  name: string;
  path: string;
  category: string;
  description?: string;
  repo: string;
}

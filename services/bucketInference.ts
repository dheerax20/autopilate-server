// =============================================================================
// Bucket Inference Service
// Maps categories, names, and descriptions to capability buckets
// =============================================================================

import {
  SUBCATEGORIES,
  getSubcategoriesForBucket,
  getDefaultSubcategory,
} from '../shared/subcategories';

/**
 * Normalize category strings for consistent matching
 * Handles variations like browser_automation, browser-automation, Browser Automation
 */
function normalizeCategory(category: string): string {
  return category
    .toLowerCase()
    .replace(/[_\s]+/g, '-') // browser_automation → browser-automation
    .replace(/[^a-z0-9-]/g, '') // Remove special chars
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
}

// =============================================================================
// Category to Bucket Mapping
// Explicit mapping from normalized category names to bucket IDs
// =============================================================================

const CATEGORY_TO_BUCKET_MAP: Record<string, string[]> = {
  // Development
  'development-team': ['development'],
  'programming-languages': ['development'],
  'api-graphql': ['development'],
  'web-tools': ['development'],
  'web-development': ['development'],
  frontend: ['development'],
  backend: ['development'],
  'game-development': ['development'],
  'blockchain-web3': ['development'],
  modernization: ['development'],
  realtime: ['development'],
  architecture: ['development'],
  refactoring: ['development'],
  'code-quality': ['development', 'testing-quality'],
  debugging: ['development'],

  // Testing & Quality
  testing: ['testing-quality'],
  'performance-testing': ['testing-quality'],
  performance: ['testing-quality'],
  qa: ['testing-quality'],
  'code-review': ['testing-quality', 'git-vcs'],
  linting: ['testing-quality'],

  // DevOps & Infrastructure
  'devops-infrastructure': ['devops-infra'],
  deployment: ['devops-infra'],
  azure: ['devops-infra', 'integrations'],
  railway: ['devops-infra'],
  monitoring: ['devops-infra', 'automation'],
  aws: ['devops-infra', 'integrations'],
  gcp: ['devops-infra', 'integrations'],
  docker: ['devops-infra'],
  kubernetes: ['devops-infra'],
  terraform: ['devops-infra'],
  cicd: ['devops-infra', 'automation'],
  'ci-cd': ['devops-infra', 'automation'],

  // Security
  security: ['security'],
  authentication: ['security'],
  authorization: ['security'],
  encryption: ['security'],
  audit: ['security'],
  compliance: ['security'],

  // Data & AI
  'data-ai': ['data-ai'],
  'ai-specialists': ['data-ai'],
  'ai-research': ['data-ai'],
  analytics: ['data-ai'],
  database: ['data-ai', 'integrations'],
  scientific: ['data-ai'],
  'deep-research-team': ['data-ai'],
  'expert-advisors': ['data-ai'],
  'machine-learning': ['data-ai'],
  ml: ['data-ai'],
  llm: ['data-ai'],
  'data-analysis': ['data-ai'],
  'data-processing': ['data-ai'],

  // Documentation
  documentation: ['documentation'],
  'document-processing': ['documentation'],
  docs: ['documentation'],
  readme: ['documentation'],
  'technical-writing': ['documentation'],
  content: ['documentation'],

  // Git & Version Control
  git: ['git-vcs'],
  'git-workflow': ['git-vcs'],
  'version-control': ['git-vcs'],
  branching: ['git-vcs'],
  merging: ['git-vcs'],

  // Automation
  automation: ['automation'],
  'workflow-automation': ['automation'],
  orchestration: ['automation'],
  'pre-tool': ['automation'],
  'post-tool': ['automation'],
  utilities: ['automation'],
  hooks: ['automation'],
  scripts: ['automation'],
  scheduling: ['automation'],

  // Integrations
  integration: ['integrations'],
  'browser-automation': ['integrations', 'automation'],
  'enterprise-communication': ['integrations'],
  'mcp-dev-team': ['integrations', 'development'],
  productivity: ['integrations'],
  slack: ['integrations'],
  discord: ['integrations'],
  github: ['integrations', 'git-vcs'],
  gitlab: ['integrations', 'git-vcs'],
  jira: ['integrations'],
  confluence: ['integrations'],
  notion: ['integrations'],
  'google-workspace': ['integrations'],
  microsoft: ['integrations'],
};

// =============================================================================
// Keyword Patterns for Fallback Inference
// Used when category doesn't match explicit mapping
// =============================================================================

const KEYWORD_PATTERNS: Record<string, string[]> = {
  development: [
    'frontend',
    'backend',
    'react',
    'vue',
    'angular',
    'api',
    'web',
    'mobile',
    'app',
    'component',
    'typescript',
    'javascript',
    'python',
    'code',
    'develop',
    'build',
    'create',
    'implement',
  ],
  'testing-quality': [
    'test',
    'spec',
    'quality',
    'coverage',
    'e2e',
    'unit',
    'integration-test',
    'qa',
    'assert',
    'expect',
    'mock',
  ],
  'devops-infra': [
    'deploy',
    'ci',
    'cd',
    'docker',
    'kubernetes',
    'aws',
    'cloud',
    'infra',
    'server',
    'host',
    'pipeline',
    'container',
  ],
  security: [
    'security',
    'auth',
    'encrypt',
    'vulnerability',
    'audit',
    'permission',
    'access',
    'credential',
    'secret',
    'token',
  ],
  'data-ai': [
    'data',
    'ai',
    'ml',
    'model',
    'analytics',
    'llm',
    'research',
    'analysis',
    'dataset',
    'train',
    'predict',
    'neural',
  ],
  documentation: [
    'doc',
    'readme',
    'markdown',
    'writing',
    'content',
    'guide',
    'tutorial',
    'reference',
    'specification',
  ],
  'git-vcs': [
    'git',
    'branch',
    'commit',
    'merge',
    'pr',
    'pull-request',
    'review',
    'rebase',
    'checkout',
    'version',
  ],
  automation: [
    'automat',
    'workflow',
    'script',
    'hook',
    'trigger',
    'schedule',
    'cron',
    'task',
    'job',
    'batch',
  ],
  integrations: [
    'slack',
    'discord',
    'webhook',
    'integration',
    'connect',
    'sync',
    'external',
    'third-party',
    'plugin',
  ],
};

// =============================================================================
// Main Inference Function
// =============================================================================

/**
 * Infer capability buckets for a component
 *
 * Strategy:
 * 1. Try explicit category mapping (after normalization)
 * 2. Fall back to keyword-based inference from name + description
 * 3. Default to 'uncategorized' if no matches
 *
 * @param category - The component's category (may be undefined)
 * @param name - The component's name
 * @param description - Optional description text
 * @returns Array of bucket IDs (never empty)
 */
export function inferBuckets(
  category: string | undefined,
  name: string,
  description?: string
): string[] {
  // 1. Try explicit category mapping
  if (category) {
    const normalized = normalizeCategory(category);
    if (CATEGORY_TO_BUCKET_MAP[normalized]) {
      return CATEGORY_TO_BUCKET_MAP[normalized];
    }
  }

  // 2. Keyword-based inference from name + description
  const searchText = `${name} ${description || ''}`.toLowerCase();
  const matchedBuckets = new Set<string>();

  for (const [bucketId, keywords] of Object.entries(KEYWORD_PATTERNS)) {
    for (const keyword of keywords) {
      if (searchText.includes(keyword)) {
        matchedBuckets.add(bucketId);
        break; // One match per bucket is enough
      }
    }
  }

  if (matchedBuckets.size > 0) {
    return Array.from(matchedBuckets);
  }

  // 3. Default to uncategorized
  return ['uncategorized'];
}

/**
 * Get all bucket IDs that a category maps to
 * Useful for debugging and testing
 */
export function getCategoryMapping(category: string): string[] | undefined {
  const normalized = normalizeCategory(category);
  return CATEGORY_TO_BUCKET_MAP[normalized];
}

/**
 * Normalize a category string (exported for testing)
 */
export { normalizeCategory };

// =============================================================================
// Subcategory Inference
// =============================================================================

/**
 * Check if a keyword matches using word boundaries
 * Prevents false positives like "ai" matching "tailwind"
 */
function matchKeyword(text: string, keyword: string): boolean {
  // Create word boundary regex for the keyword
  // Escape special regex characters in keyword
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}`, 'i');
  return regex.test(text);
}

/**
 * Infer subcategory within a specific bucket
 *
 * Strategy:
 * 1. Try explicit category mapping (after normalization)
 * 2. Fall back to keyword-based inference with word boundaries
 * 3. Return bucket's explicit default subcategory
 *
 * @param bucketId - The bucket this item belongs to
 * @param category - The component's category (may be undefined)
 * @param name - The component's name
 * @param description - Optional description text
 * @returns Subcategory ID (never undefined)
 */
export function inferSubcategory(
  bucketId: string,
  category: string | undefined,
  name: string,
  description?: string
): string {
  const bucketSubcategories = getSubcategoriesForBucket(bucketId);

  if (bucketSubcategories.length === 0) {
    return 'other'; // Fallback for uncategorized bucket
  }

  // 1. Try explicit category mapping (with normalization)
  if (category) {
    const normalized = normalizeCategory(category);
    for (const subcat of bucketSubcategories) {
      if (subcat.categories.includes(normalized)) {
        return subcat.id;
      }
    }
  }

  // 2. Keyword-based inference with word boundaries
  const searchText = `${name} ${description || ''}`.toLowerCase();
  for (const subcat of bucketSubcategories) {
    for (const keyword of subcat.keywords) {
      if (matchKeyword(searchText, keyword)) {
        return subcat.id;
      }
    }
  }

  // 3. Return explicit default for this bucket
  return getDefaultSubcategory(bucketId);
}

/**
 * Combined inference: returns both buckets and parallel subcategories
 *
 * For items that map to multiple buckets (e.g., "database" -> [data-ai, integrations]),
 * this returns parallel arrays where subcategories[i] corresponds to buckets[i].
 *
 * @returns { buckets: string[], subcategories: string[] } - Parallel arrays
 */
export function inferBucketAndSubcategory(
  category: string | undefined,
  name: string,
  description?: string
): { buckets: string[]; subcategories: string[] } {
  const buckets = inferBuckets(category, name, description);

  // Generate parallel subcategory array
  const subcategories = buckets.map(bucketId =>
    inferSubcategory(bucketId, category, name, description)
  );

  return { buckets, subcategories };
}

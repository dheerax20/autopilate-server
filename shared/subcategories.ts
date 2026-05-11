// =============================================================================
// Subcategory Taxonomy - Single Source of Truth
// Imported by both server/services/bucketInference.ts and src/constants/subcategories.ts
// =============================================================================

export interface Subcategory {
  id: string;
  name: string;
  bucketId: string;
  categories: string[];    // Explicit category mappings (normalized)
  keywords: string[];      // Fallback keyword patterns (word-boundary matched)
  isDefault?: boolean;     // True if this is the default subcategory for its bucket
}

export const SUBCATEGORIES: Subcategory[] = [
  // ==========================================================================
  // Development bucket (default: dev-general)
  // ==========================================================================
  { id: 'frontend', name: 'Frontend', bucketId: 'development',
    categories: ['frontend', 'web-development', 'web-tools'],
    keywords: ['react', 'vue', 'angular', 'svelte', 'nextjs', 'css', 'tailwind', 'ui', 'component'] },
  { id: 'backend', name: 'Backend', bucketId: 'development',
    categories: ['backend', 'api-graphql'],
    keywords: ['api', 'graphql', 'rest', 'server', 'express', 'fastapi', 'endpoint'] },
  { id: 'languages', name: 'Languages', bucketId: 'development',
    categories: ['programming-languages'],
    keywords: ['python', 'typescript', 'javascript', 'rust', 'golang', 'java', 'ruby', 'php'] },
  { id: 'architecture', name: 'Architecture', bucketId: 'development',
    categories: ['architecture', 'refactoring', 'modernization'],
    keywords: ['architect', 'refactor', 'migrate', 'design-pattern', 'microservice'] },
  { id: 'mobile-game', name: 'Mobile & Games', bucketId: 'development',
    categories: ['game-development', 'mobile'],
    keywords: ['unity', 'godot', 'ios', 'android', 'react-native', 'flutter', 'game'] },
  { id: 'blockchain', name: 'Blockchain', bucketId: 'development',
    categories: ['blockchain-web3'],
    keywords: ['solidity', 'ethereum', 'web3', 'smart-contract', 'crypto', 'nft'] },
  { id: 'realtime', name: 'Realtime', bucketId: 'development',
    categories: ['realtime'],
    keywords: ['websocket', 'socket', 'streaming', 'realtime', 'live', 'pubsub'] },
  { id: 'dev-general', name: 'General', bucketId: 'development',
    categories: ['development-team', 'debugging', 'code-quality'],
    keywords: ['debug', 'lint', 'format', 'develop'],
    isDefault: true },

  // ==========================================================================
  // Testing & Quality bucket (default: unit-integration)
  // ==========================================================================
  { id: 'unit-integration', name: 'Unit & Integration', bucketId: 'testing-quality',
    categories: ['testing', 'unit', 'integration-test'],
    keywords: ['jest', 'vitest', 'mocha', 'pytest', 'unittest', 'spec'],
    isDefault: true },
  { id: 'e2e', name: 'End-to-End', bucketId: 'testing-quality',
    categories: ['e2e'],
    keywords: ['playwright', 'cypress', 'selenium', 'puppeteer', 'e2e', 'end-to-end'] },
  { id: 'performance', name: 'Performance', bucketId: 'testing-quality',
    categories: ['performance-testing', 'performance'],
    keywords: ['benchmark', 'load-test', 'stress', 'perf', 'profil'] },
  { id: 'code-review', name: 'Code Review', bucketId: 'testing-quality',
    categories: ['code-review', 'linting', 'qa'],
    keywords: ['review', 'quality', 'eslint', 'prettier', 'static-analysis'] },

  // ==========================================================================
  // DevOps & Infrastructure bucket (default: cicd)
  // ==========================================================================
  { id: 'containers', name: 'Containers', bucketId: 'devops-infra',
    categories: ['docker', 'kubernetes'],
    keywords: ['docker', 'k8s', 'kubernetes', 'container', 'helm', 'pod', 'image'] },
  { id: 'cloud-aws', name: 'AWS', bucketId: 'devops-infra',
    categories: ['aws'],
    keywords: ['aws', 'lambda', 's3', 'ec2', 'dynamodb', 'cloudformation', 'sqs', 'sns'] },
  { id: 'cloud-azure', name: 'Azure', bucketId: 'devops-infra',
    categories: ['azure'],
    keywords: ['azure', 'arm', 'functions', 'blob', 'cosmosdb'] },
  { id: 'cloud-gcp', name: 'GCP', bucketId: 'devops-infra',
    categories: ['gcp'],
    keywords: ['gcp', 'gcloud', 'bigquery', 'cloud-run', 'firestore', 'pubsub'] },
  { id: 'iac', name: 'Infrastructure as Code', bucketId: 'devops-infra',
    categories: ['terraform', 'infrastructure'],
    keywords: ['terraform', 'pulumi', 'ansible', 'iac', 'cloudformation', 'cdk'] },
  { id: 'cicd', name: 'CI/CD', bucketId: 'devops-infra',
    categories: ['cicd', 'ci-cd', 'deployment'],
    keywords: ['ci', 'cd', 'pipeline', 'deploy', 'github-actions', 'jenkins', 'gitlab-ci'],
    isDefault: true },
  { id: 'monitoring', name: 'Monitoring', bucketId: 'devops-infra',
    categories: ['monitoring'],
    keywords: ['monitor', 'observability', 'prometheus', 'grafana', 'datadog', 'logging', 'alert'] },

  // ==========================================================================
  // Security bucket (default: audit-compliance)
  // ==========================================================================
  { id: 'auth', name: 'Authentication', bucketId: 'security',
    categories: ['authentication', 'authorization'],
    keywords: ['auth', 'oauth', 'jwt', 'login', 'session', 'permission', 'rbac', 'iam'] },
  { id: 'encryption', name: 'Encryption', bucketId: 'security',
    categories: ['encryption'],
    keywords: ['encrypt', 'decrypt', 'crypto', 'hash', 'ssl', 'tls', 'certificate'] },
  { id: 'audit-compliance', name: 'Audit & Compliance', bucketId: 'security',
    categories: ['audit', 'compliance', 'security'],
    keywords: ['audit', 'compliance', 'gdpr', 'hipaa', 'soc2', 'pci', 'security'],
    isDefault: true },
  { id: 'vulnerability', name: 'Vulnerability', bucketId: 'security',
    categories: ['vulnerability', 'scanning'],
    keywords: ['vulnerability', 'cve', 'scan', 'pentest', 'exploit', 'injection'] },

  // ==========================================================================
  // Data & AI bucket (default: llm)
  // ==========================================================================
  { id: 'llm', name: 'LLMs & Agents', bucketId: 'data-ai',
    categories: ['llm', 'ai-specialists', 'ai-research'],
    keywords: ['llm', 'gpt', 'claude', 'agent', 'prompt', 'langchain', 'openai', 'anthropic'],
    isDefault: true },
  { id: 'ml', name: 'Machine Learning', bucketId: 'data-ai',
    categories: ['machine-learning', 'ml', 'data-analysis'],
    keywords: ['ml', 'model', 'train', 'neural', 'tensorflow', 'pytorch', 'sklearn'] },
  { id: 'analytics', name: 'Analytics', bucketId: 'data-ai',
    categories: ['analytics', 'data-processing'],
    keywords: ['analytics', 'metrics', 'dashboard', 'report', 'visualization', 'chart'] },
  { id: 'database', name: 'Databases', bucketId: 'data-ai',
    categories: ['database'],
    keywords: ['sql', 'postgres', 'mysql', 'mongodb', 'redis', 'database', 'query', 'schema'] },
  { id: 'research', name: 'Research', bucketId: 'data-ai',
    categories: ['deep-research-team', 'scientific', 'expert-advisors'],
    keywords: ['research', 'paper', 'academic', 'scientific', 'expert', 'study'] },

  // ==========================================================================
  // Documentation bucket (default: technical)
  // ==========================================================================
  { id: 'technical', name: 'Technical Docs', bucketId: 'documentation',
    categories: ['documentation', 'technical-writing'],
    keywords: ['doc', 'documentation', 'technical', 'api-docs', 'specification', 'jsdoc'],
    isDefault: true },
  { id: 'readme', name: 'READMEs', bucketId: 'documentation',
    categories: ['readme', 'docs'],
    keywords: ['readme', 'getting-started', 'quickstart', 'installation'] },
  { id: 'content', name: 'Content', bucketId: 'documentation',
    categories: ['content', 'document-processing'],
    keywords: ['content', 'writing', 'blog', 'article', 'tutorial', 'guide'] },

  // ==========================================================================
  // Git & VCS bucket (default: git-general)
  // ==========================================================================
  { id: 'branching', name: 'Branching', bucketId: 'git-vcs',
    categories: ['branching', 'merging', 'git-workflow'],
    keywords: ['branch', 'merge', 'rebase', 'workflow', 'gitflow'] },
  { id: 'commits', name: 'Commits & PRs', bucketId: 'git-vcs',
    categories: ['commits', 'pr'],
    keywords: ['commit', 'pr', 'pull-request', 'push', 'changelog'] },
  { id: 'git-general', name: 'General', bucketId: 'git-vcs',
    categories: ['git', 'version-control'],
    keywords: ['git', 'vcs', 'version', 'repo', 'clone'],
    isDefault: true },

  // ==========================================================================
  // Automation bucket (default: workflows)
  // ==========================================================================
  { id: 'workflows', name: 'Workflows', bucketId: 'automation',
    categories: ['workflow-automation', 'orchestration'],
    keywords: ['workflow', 'orchestrat', 'automat', 'pipeline', 'flow'],
    isDefault: true },
  { id: 'hooks', name: 'Hooks', bucketId: 'automation',
    categories: ['hooks', 'pre-tool', 'post-tool'],
    keywords: ['hook', 'pre-commit', 'post-commit', 'trigger', 'callback'] },
  { id: 'scripts', name: 'Scripts', bucketId: 'automation',
    categories: ['scripts', 'utilities', 'scheduling'],
    keywords: ['script', 'cron', 'schedule', 'batch', 'task', 'job'] },

  // ==========================================================================
  // Integrations bucket (default: webhooks)
  // ==========================================================================
  { id: 'communication', name: 'Communication', bucketId: 'integrations',
    categories: ['slack', 'discord', 'enterprise-communication'],
    keywords: ['slack', 'discord', 'teams', 'chat', 'message', 'notify'] },
  { id: 'productivity', name: 'Productivity', bucketId: 'integrations',
    categories: ['productivity', 'notion', 'confluence', 'jira'],
    keywords: ['notion', 'confluence', 'jira', 'asana', 'trello', 'linear', 'project'] },
  { id: 'cloud-services', name: 'Cloud Services', bucketId: 'integrations',
    categories: ['google-workspace', 'microsoft'],
    keywords: ['google', 'microsoft', 'office', 'workspace', 'drive', 'sheets', 'outlook'] },
  { id: 'browser', name: 'Browser', bucketId: 'integrations',
    categories: ['browser-automation'],
    keywords: ['browser', 'chrome', 'puppeteer', 'playwright', 'scrape', 'crawl'] },
  { id: 'webhooks', name: 'Webhooks & APIs', bucketId: 'integrations',
    categories: ['integration', 'webhook'],
    keywords: ['webhook', 'api', 'rest', 'integration', 'connect', 'sync'],
    isDefault: true },

  // ==========================================================================
  // Uncategorized bucket (default: other)
  // ==========================================================================
  { id: 'other', name: 'Other', bucketId: 'uncategorized',
    categories: [],
    keywords: [],
    isDefault: true },
];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get all subcategories for a specific bucket
 */
export function getSubcategoriesForBucket(bucketId: string): Subcategory[] {
  return SUBCATEGORIES.filter(sc => sc.bucketId === bucketId);
}

/**
 * Get a subcategory by its ID
 */
export function getSubcategory(subcategoryId: string): Subcategory | undefined {
  return SUBCATEGORIES.find(sc => sc.id === subcategoryId);
}

/**
 * Get the default subcategory for a bucket
 */
export function getDefaultSubcategory(bucketId: string): string {
  const defaultSc = SUBCATEGORIES.find(sc => sc.bucketId === bucketId && sc.isDefault);
  if (defaultSc) return defaultSc.id;

  // Fallback: return first subcategory for bucket, or 'other'
  const firstSc = SUBCATEGORIES.find(sc => sc.bucketId === bucketId);
  return firstSc?.id || 'other';
}

/**
 * Get display info for frontend (without inference logic)
 */
export interface SubcategoryInfo {
  id: string;
  name: string;
  bucketId: string;
  isDefault: boolean;
}

export function getSubcategoryInfo(subcategoryId: string): SubcategoryInfo | undefined {
  const sc = getSubcategory(subcategoryId);
  if (!sc) return undefined;
  return {
    id: sc.id,
    name: sc.name,
    bucketId: sc.bucketId,
    isDefault: sc.isDefault || false,
  };
}

export function getAllSubcategoryInfo(): SubcategoryInfo[] {
  return SUBCATEGORIES.map(sc => ({
    id: sc.id,
    name: sc.name,
    bucketId: sc.bucketId,
    isDefault: sc.isDefault || false,
  }));
}

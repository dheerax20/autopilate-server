import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildSearchIndex,
  searchInventory,
  extractFacets,
  InventoryItem,
  FlattenedItem,
} from './inventory';
import { inferBuckets } from './bucketInference';

// =============================================================================
// Test Data
// =============================================================================

const mockInventory: InventoryItem[] = [
  {
    id: 'agents',
    name: 'agents',
    path: 'agents',
    type: 'folder',
    children: [
      {
        id: 'agents/repo1',
        name: 'repo1',
        path: 'agents/repo1',
        type: 'folder',
        repo: 'repo1',
        children: [
          {
            id: 'agents/repo1/dev',
            name: 'dev',
            path: 'agents/repo1/dev',
            type: 'folder',
            repo: 'repo1',
            children: [
              {
                id: '/path/to/frontend-agent.md',
                name: 'frontend-agent',
                path: '/path/to/frontend-agent.md',
                type: 'file',
                category: 'AGENT',
                description: 'A frontend development specialist',
                repo: 'repo1',
              },
              {
                id: '/path/to/backend-agent.md',
                name: 'backend-agent',
                path: '/path/to/backend-agent.md',
                type: 'file',
                category: 'AGENT',
                description: 'A backend API specialist',
                repo: 'repo1',
              },
            ],
          },
        ],
      },
      {
        id: 'agents/repo2',
        name: 'repo2',
        path: 'agents/repo2',
        type: 'folder',
        repo: 'repo2',
        children: [
          {
            id: '/path/to/testing-agent.md',
            name: 'testing-agent',
            path: '/path/to/testing-agent.md',
            type: 'file',
            category: 'AGENT',
            description: 'A testing and QA specialist',
            repo: 'repo2',
          },
        ],
      },
    ],
  },
  {
    id: 'skills',
    name: 'skills',
    path: 'skills',
    type: 'folder',
    children: [
      {
        id: 'skills/repo1',
        name: 'repo1',
        path: 'skills/repo1',
        type: 'folder',
        repo: 'repo1',
        children: [
          {
            id: '/path/to/code-review.md',
            name: 'code-review',
            path: '/path/to/code-review.md',
            type: 'file',
            category: 'SKILL',
            description: 'Code review capability',
            repo: 'repo1',
          },
        ],
      },
    ],
  },
  {
    id: 'bundles',
    name: 'bundles',
    path: 'bundles',
    type: 'folder',
    children: [
      {
        id: 'bundle/test-bundle',
        name: 'test-bundle',
        path: '/path/to/test-bundle',
        type: 'bundle',
        description: 'A test bundle with multiple components',
        repo: 'repo1',
        bundleData: {
          description: 'A test bundle with multiple components',
          components: {
            agents: [
              {
                name: 'bundle-agent',
                path: '/path/to/bundle/agents/bundle-agent.md',
                category: 'agents',
                description: 'Agent from bundle',
              },
            ],
            commands: [],
            skills: [
              {
                name: 'bundle-skill',
                path: '/path/to/bundle/skills/bundle-skill.md',
                category: 'skills',
                description: 'Skill from bundle',
              },
            ],
            hooks: [],
          },
          totalCount: 2,
        },
      },
    ],
  },
];

// =============================================================================
// Tests: buildSearchIndex
// =============================================================================

describe('buildSearchIndex', () => {
  it('should flatten inventory tree into searchable items', () => {
    const index = buildSearchIndex(mockInventory);

    // Should have: 3 agents + 1 skill + 1 bundle + 2 bundle components = 7
    expect(index.length).toBe(7);
  });

  it('should include file items with correct properties', () => {
    const index = buildSearchIndex(mockInventory);

    const frontendAgent = index.find((i) => i.name === 'frontend-agent');
    expect(frontendAgent).toBeDefined();
    expect(frontendAgent?.nodeType).toBe('AGENT');
    expect(frontendAgent?.repo).toBe('repo1');
    expect(frontendAgent?.description).toBe('A frontend development specialist');
    expect(frontendAgent?.isBundle).toBe(false);
  });

  it('should include bundles in the index', () => {
    const index = buildSearchIndex(mockInventory);

    const bundle = index.find((i) => i.name === 'test-bundle');
    expect(bundle).toBeDefined();
    expect(bundle?.nodeType).toBe('BUNDLE');
    expect(bundle?.isBundle).toBe(true);
  });

  it('should include bundle components in the index', () => {
    const index = buildSearchIndex(mockInventory);

    const bundleAgent = index.find((i) => i.name === 'bundle-agent');
    expect(bundleAgent).toBeDefined();
    expect(bundleAgent?.nodeType).toBe('AGENT');
    expect(bundleAgent?.isBundle).toBe(false);

    const bundleSkill = index.find((i) => i.name === 'bundle-skill');
    expect(bundleSkill).toBeDefined();
    expect(bundleSkill?.nodeType).toBe('SKILL');
  });

  it('should generate searchText for each item', () => {
    const index = buildSearchIndex(mockInventory);

    const frontendAgent = index.find((i) => i.name === 'frontend-agent');
    expect(frontendAgent?.searchText).toContain('frontend-agent');
    expect(frontendAgent?.searchText).toContain('frontend development specialist');
    expect(frontendAgent?.searchText).toContain('repo1');
  });
});

// =============================================================================
// Tests: extractFacets
// =============================================================================

describe('extractFacets', () => {
  it('should extract unique repos', () => {
    const index = buildSearchIndex(mockInventory);
    const facets = extractFacets(index);

    expect(facets.repos).toContain('repo1');
    expect(facets.repos).toContain('repo2');
    expect(facets.repos.length).toBe(2);
  });

  it('should extract unique types', () => {
    const index = buildSearchIndex(mockInventory);
    const facets = extractFacets(index);

    expect(facets.types).toContain('AGENT');
    expect(facets.types).toContain('SKILL');
    expect(facets.types).toContain('BUNDLE');
  });

  it('should sort facet values alphabetically', () => {
    const index = buildSearchIndex(mockInventory);
    const facets = extractFacets(index);

    expect(facets.repos).toEqual([...facets.repos].sort());
    expect(facets.types).toEqual([...facets.types].sort());
  });
});

// =============================================================================
// Tests: searchInventory
// =============================================================================

describe('searchInventory', () => {
  let index: FlattenedItem[];

  beforeEach(() => {
    index = buildSearchIndex(mockInventory);
  });

  describe('text search', () => {
    it('should filter by search query', () => {
      const result = searchInventory(index, 'frontend');

      expect(result.items.length).toBe(1);
      expect(result.items[0].name).toBe('frontend-agent');
    });

    it('should match multiple terms (AND)', () => {
      const result = searchInventory(index, 'agent frontend');

      expect(result.items.length).toBe(1);
      expect(result.items[0].name).toBe('frontend-agent');
    });

    it('should be case insensitive', () => {
      const result = searchInventory(index, 'FRONTEND');

      expect(result.items.length).toBe(1);
      expect(result.items[0].name).toBe('frontend-agent');
    });

    it('should return all items with empty query', () => {
      const result = searchInventory(index, '');

      expect(result.items.length).toBe(index.length);
    });
  });

  describe('type filter', () => {
    it('should filter by single type', () => {
      const result = searchInventory(index, undefined, { types: ['AGENT'] });

      expect(result.items.every((i) => i.nodeType === 'AGENT')).toBe(true);
    });

    it('should filter by multiple types', () => {
      const result = searchInventory(index, undefined, {
        types: ['AGENT', 'SKILL'],
      });

      expect(
        result.items.every(
          (i) => i.nodeType === 'AGENT' || i.nodeType === 'SKILL'
        )
      ).toBe(true);
    });

    it('should be case insensitive for types', () => {
      const result = searchInventory(index, undefined, { types: ['agent'] });

      expect(result.items.every((i) => i.nodeType === 'AGENT')).toBe(true);
    });
  });

  describe('repo filter', () => {
    it('should filter by single repo', () => {
      const result = searchInventory(index, undefined, { repos: ['repo1'] });

      expect(result.items.every((i) => i.repo === 'repo1')).toBe(true);
    });

    it('should filter by multiple repos', () => {
      const result = searchInventory(index, undefined, {
        repos: ['repo1', 'repo2'],
      });

      expect(
        result.items.every((i) => i.repo === 'repo1' || i.repo === 'repo2')
      ).toBe(true);
    });
  });

  describe('combined filters', () => {
    it('should combine query and type filter', () => {
      const result = searchInventory(index, 'agent', { types: ['AGENT'] });

      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.every((i) => i.nodeType === 'AGENT')).toBe(true);
      expect(
        result.items.every((i) => i.searchText.includes('agent'))
      ).toBe(true);
    });

    it('should combine multiple filters', () => {
      const result = searchInventory(index, 'agent', {
        types: ['AGENT'],
        repos: ['repo1'],
      });

      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.every((i) => i.nodeType === 'AGENT')).toBe(true);
      expect(result.items.every((i) => i.repo === 'repo1')).toBe(true);
    });
  });

  describe('pagination', () => {
    it('should respect limit parameter', () => {
      const result = searchInventory(index, undefined, undefined, { limit: 2 });

      expect(result.items.length).toBe(2);
      expect(result.limit).toBe(2);
    });

    it('should respect offset parameter', () => {
      const result1 = searchInventory(index, undefined, undefined, {
        limit: 2,
        offset: 0,
      });
      const result2 = searchInventory(index, undefined, undefined, {
        limit: 2,
        offset: 2,
      });

      expect(result1.items[0].id).not.toBe(result2.items[0].id);
    });

    it('should return total count before pagination', () => {
      const result = searchInventory(index, undefined, undefined, { limit: 2 });

      expect(result.total).toBe(index.length);
      expect(result.items.length).toBe(2);
    });

    it('should use default limit of 100', () => {
      const result = searchInventory(index);

      expect(result.limit).toBe(100);
    });
  });

  describe('facets', () => {
    it('should return facets for filtered results', () => {
      const result = searchInventory(index, undefined, { types: ['AGENT'] });

      // Facets should reflect the filtered results
      expect(result.facets.types).toContain('AGENT');
    });

    it('should update facets based on filters', () => {
      const allResult = searchInventory(index);
      const filteredResult = searchInventory(index, undefined, {
        repos: ['repo1'],
      });

      // Filtered facets should have fewer or equal repos
      expect(filteredResult.facets.repos.length).toBeLessThanOrEqual(
        allResult.facets.repos.length
      );
    });
  });
});

// =============================================================================
// Tests: Bucket Filtering
// =============================================================================

describe('bucket filtering', () => {
  let index: FlattenedItem[];

  beforeEach(() => {
    index = buildSearchIndex(mockInventory);
  });

  it('should filter by single bucket', () => {
    // First, check what buckets exist in the index
    const allBuckets = new Set<string>();
    for (const item of index) {
      for (const bucket of item.buckets) {
        allBuckets.add(bucket);
      }
    }

    // Get items in development bucket
    const result = searchInventory(index, undefined, { buckets: ['development'] });

    // All results should have 'development' in their buckets
    expect(result.items.every((i) => i.buckets.includes('development'))).toBe(true);
  });

  it('should filter by multiple buckets (OR logic)', () => {
    const result = searchInventory(index, undefined, {
      buckets: ['development', 'testing-quality'],
    });

    // All results should have either 'development' or 'testing-quality'
    expect(
      result.items.every(
        (i) => i.buckets.includes('development') || i.buckets.includes('testing-quality')
      )
    ).toBe(true);
  });

  it('should combine bucket filter with type filter', () => {
    const result = searchInventory(index, undefined, {
      types: ['AGENT'],
      buckets: ['development'],
    });

    expect(result.items.every((i) => i.nodeType === 'AGENT')).toBe(true);
    expect(result.items.every((i) => i.buckets.includes('development'))).toBe(true);
  });

  it('should include buckets in facets', () => {
    const result = searchInventory(index);

    expect(result.facets.buckets).toBeDefined();
    expect(result.facets.buckets.length).toBeGreaterThan(0);
  });

  it('should have non-empty buckets for all items', () => {
    for (const item of index) {
      expect(item.buckets).toBeDefined();
      expect(item.buckets.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// Tests: Edge Cases
// =============================================================================

describe('edge cases', () => {
  it('should handle empty inventory', () => {
    const index = buildSearchIndex([]);
    expect(index.length).toBe(0);

    const result = searchInventory(index, 'test');
    expect(result.items.length).toBe(0);
    expect(result.total).toBe(0);
  });

  it('should handle inventory with only folders', () => {
    const emptyFolders: InventoryItem[] = [
      {
        id: 'empty',
        name: 'empty',
        path: 'empty',
        type: 'folder',
        children: [],
      },
    ];

    const index = buildSearchIndex(emptyFolders);
    expect(index.length).toBe(0);
  });

  it('should handle items without descriptions', () => {
    const noDescInventory: InventoryItem[] = [
      {
        id: 'test',
        name: 'test',
        path: 'test',
        type: 'folder',
        children: [
          {
            id: '/path/to/test.md',
            name: 'test-file',
            path: '/path/to/test.md',
            type: 'file',
            category: 'AGENT',
            // No description
          },
        ],
      },
    ];

    const index = buildSearchIndex(noDescInventory);
    expect(index.length).toBe(1);
    expect(index[0].searchText).toContain('test-file');
  });

  it('should handle bundles with empty components', () => {
    const emptyBundle: InventoryItem[] = [
      {
        id: 'bundles',
        name: 'bundles',
        path: 'bundles',
        type: 'folder',
        children: [
          {
            id: 'bundle/empty',
            name: 'empty-bundle',
            path: '/path/to/empty-bundle',
            type: 'bundle',
            bundleData: {
              components: {
                agents: [],
                commands: [],
                skills: [],
                hooks: [],
              },
              totalCount: 0,
            },
          },
        ],
      },
    ];

    const index = buildSearchIndex(emptyBundle);
    // Should include the bundle itself even if empty
    expect(index.length).toBe(1);
    expect(index[0].name).toBe('empty-bundle');
  });
});

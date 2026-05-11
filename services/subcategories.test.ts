import { describe, it, expect } from 'vitest';
import {
  SUBCATEGORIES,
  getSubcategoriesForBucket,
  getSubcategory,
  getDefaultSubcategory,
} from '../shared/subcategories';
import { inferSubcategory, inferBucketAndSubcategory } from './bucketInference';

// =============================================================================
// Tests: Shared Subcategory Helpers
// =============================================================================

describe('subcategories - shared helpers', () => {
  describe('getSubcategoriesForBucket', () => {
    it('should return subcategories for development bucket', () => {
      const subcats = getSubcategoriesForBucket('development');
      const ids = subcats.map(sc => sc.id);
      expect(ids).toContain('frontend');
      expect(ids).toContain('backend');
      expect(ids).toContain('dev-general');
    });

    it('should return subcategories for all major buckets', () => {
      const bucketIds = [
        'development', 'testing-quality', 'devops-infra', 'security',
        'data-ai', 'documentation', 'git-vcs', 'automation', 'integrations'
      ];

      for (const bucketId of bucketIds) {
        const subcats = getSubcategoriesForBucket(bucketId);
        expect(subcats.length).toBeGreaterThan(0);
      }
    });

    it('should return empty array for unknown bucket', () => {
      const subcats = getSubcategoriesForBucket('unknown-bucket-xyz');
      expect(subcats).toEqual([]);
    });
  });

  describe('getSubcategory', () => {
    it('should find subcategory by ID', () => {
      const subcat = getSubcategory('frontend');
      expect(subcat).toBeDefined();
      expect(subcat?.bucketId).toBe('development');
      expect(subcat?.name).toBe('Frontend');
    });

    it('should return undefined for unknown ID', () => {
      expect(getSubcategory('unknown-xyz')).toBeUndefined();
    });
  });

  describe('getDefaultSubcategory', () => {
    it('should return explicit default for development', () => {
      expect(getDefaultSubcategory('development')).toBe('dev-general');
    });

    it('should return explicit default for data-ai', () => {
      expect(getDefaultSubcategory('data-ai')).toBe('llm');
    });

    it('should return other for uncategorized', () => {
      expect(getDefaultSubcategory('uncategorized')).toBe('other');
    });

    it('should return other for unknown bucket', () => {
      expect(getDefaultSubcategory('unknown-bucket')).toBe('other');
    });
  });

  describe('SUBCATEGORIES structure', () => {
    it('should have exactly one default per bucket with subcategories', () => {
      const bucketDefaults: Record<string, number> = {};

      for (const sc of SUBCATEGORIES) {
        if (sc.isDefault) {
          bucketDefaults[sc.bucketId] = (bucketDefaults[sc.bucketId] || 0) + 1;
        }
      }

      // Each bucket that has subcategories should have exactly one default
      for (const [bucketId, count] of Object.entries(bucketDefaults)) {
        expect(count).toBe(1);
      }
    });

    it('should have all required fields for each subcategory', () => {
      for (const sc of SUBCATEGORIES) {
        expect(sc.id).toBeTruthy();
        expect(sc.name).toBeTruthy();
        expect(sc.bucketId).toBeTruthy();
        expect(Array.isArray(sc.categories)).toBe(true);
        expect(Array.isArray(sc.keywords)).toBe(true);
      }
    });
  });
});

// =============================================================================
// Tests: Subcategory Inference
// =============================================================================

describe('inferSubcategory', () => {
  describe('explicit category mapping', () => {
    it('should infer frontend from frontend category', () => {
      expect(inferSubcategory('development', 'frontend', 'app')).toBe('frontend');
    });

    it('should infer frontend from web-development category', () => {
      expect(inferSubcategory('development', 'web-development', 'app')).toBe('frontend');
    });

    it('should normalize category before matching', () => {
      expect(inferSubcategory('development', 'Web_Development', 'app')).toBe('frontend');
      expect(inferSubcategory('development', 'web development', 'app')).toBe('frontend');
    });

    it('should infer backend from api-graphql category', () => {
      expect(inferSubcategory('development', 'api-graphql', 'server')).toBe('backend');
    });

    it('should infer containers from docker category', () => {
      expect(inferSubcategory('devops-infra', 'docker', 'container')).toBe('containers');
    });

    it('should infer auth from authentication category', () => {
      expect(inferSubcategory('security', 'authentication', 'login')).toBe('auth');
    });
  });

  describe('keyword inference with word boundaries', () => {
    it('should match react keyword for frontend', () => {
      expect(inferSubcategory('development', undefined, 'react-dashboard')).toBe('frontend');
    });

    it('should not match ai in tailwind (word boundary)', () => {
      const result = inferSubcategory('data-ai', undefined, 'tailwind-app');
      // Should not match 'ai' keyword because it's part of 'tailwind'
      // Should fall back to default (llm)
      expect(result).toBe('llm');
    });

    it('should match ai as standalone word', () => {
      expect(inferSubcategory('data-ai', undefined, 'ai-assistant')).toBe('llm');
    });

    it('should match python keyword for languages', () => {
      expect(inferSubcategory('development', undefined, 'python-script-helper')).toBe('languages');
    });

    it('should match jest keyword for unit-integration', () => {
      expect(inferSubcategory('testing-quality', undefined, 'jest-runner')).toBe('unit-integration');
    });

    it('should match playwright keyword for e2e', () => {
      expect(inferSubcategory('testing-quality', undefined, 'playwright-tests')).toBe('e2e');
    });

    it('should match docker keyword for containers', () => {
      expect(inferSubcategory('devops-infra', undefined, 'docker-compose-helper')).toBe('containers');
    });
  });

  describe('default subcategory fallback', () => {
    it('should return dev-general for unmatched development items', () => {
      expect(inferSubcategory('development', 'unknown', 'xyz')).toBe('dev-general');
    });

    it('should return llm for unmatched data-ai items', () => {
      expect(inferSubcategory('data-ai', 'unknown', 'xyz')).toBe('llm');
    });

    it('should return other for uncategorized bucket', () => {
      expect(inferSubcategory('uncategorized', undefined, 'anything')).toBe('other');
    });

    it('should return cicd for unmatched devops-infra items', () => {
      expect(inferSubcategory('devops-infra', 'unknown', 'xyz')).toBe('cicd');
    });

    it('should return workflows for unmatched automation items', () => {
      expect(inferSubcategory('automation', 'unknown', 'xyz')).toBe('workflows');
    });
  });
});

// =============================================================================
// Tests: Combined Bucket and Subcategory Inference
// =============================================================================

describe('inferBucketAndSubcategory', () => {
  it('should return parallel arrays for single bucket', () => {
    const result = inferBucketAndSubcategory('frontend', 'react-app');
    expect(result.buckets).toContain('development');
    expect(result.subcategories.length).toBe(result.buckets.length);
    expect(result.subcategories).toContain('frontend');
  });

  it('should return parallel arrays for multi-bucket category', () => {
    // database maps to both data-ai and integrations
    const result = inferBucketAndSubcategory('database', 'postgres-manager');
    expect(result.buckets.length).toBe(2);
    expect(result.subcategories.length).toBe(2);

    // Each subcategory should correspond to its bucket
    const dataAiIndex = result.buckets.indexOf('data-ai');
    const integrationsIndex = result.buckets.indexOf('integrations');

    if (dataAiIndex >= 0) {
      expect(result.subcategories[dataAiIndex]).toBe('database');
    }
    if (integrationsIndex >= 0) {
      // integrations bucket should get database subcategory (from keyword)
      // or webhooks (default) if no keyword match
      expect(['webhooks', 'database']).toContain(result.subcategories[integrationsIndex]);
    }
  });

  it('should handle keyword-based bucket inference', () => {
    const result = inferBucketAndSubcategory(undefined, 'react-component', 'A React UI component');
    expect(result.buckets).toContain('development');
    expect(result.subcategories.length).toBe(result.buckets.length);
  });

  it('should handle uncategorized items', () => {
    const result = inferBucketAndSubcategory(undefined, 'xyz123');
    expect(result.buckets).toContain('uncategorized');
    expect(result.subcategories).toContain('other');
  });

  it('should ensure arrays are always parallel', () => {
    // Test various inputs to ensure parallel array invariant
    const testCases = [
      { category: 'security', name: 'auth-helper' },
      { category: 'azure', name: 'azure-deploy' },
      { category: undefined, name: 'random-tool' },
      { category: 'testing', name: 'test-runner' },
    ];

    for (const tc of testCases) {
      const result = inferBucketAndSubcategory(tc.category, tc.name);
      expect(result.buckets.length).toBe(result.subcategories.length);
      expect(result.buckets.length).toBeGreaterThan(0);
    }
  });
});

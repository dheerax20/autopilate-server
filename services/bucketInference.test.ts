import { describe, it, expect } from 'vitest';
import {
  inferBuckets,
  getCategoryMapping,
  normalizeCategory,
} from './bucketInference';

// =============================================================================
// Tests: normalizeCategory
// =============================================================================

describe('normalizeCategory', () => {
  it('should convert underscores to hyphens', () => {
    expect(normalizeCategory('browser_automation')).toBe('browser-automation');
  });

  it('should convert spaces to hyphens', () => {
    expect(normalizeCategory('development team')).toBe('development-team');
  });

  it('should convert to lowercase', () => {
    expect(normalizeCategory('Development-Team')).toBe('development-team');
  });

  it('should remove special characters', () => {
    expect(normalizeCategory('ai/ml')).toBe('aiml');
    expect(normalizeCategory('data & ai')).toBe('data-ai');
  });

  it('should handle multiple spaces/underscores', () => {
    expect(normalizeCategory('web__development')).toBe('web-development');
    expect(normalizeCategory('web  development')).toBe('web-development');
  });
});

// =============================================================================
// Tests: inferBuckets - Explicit Category Mapping
// =============================================================================

describe('inferBuckets - explicit category mapping', () => {
  it('should map development-team to development', () => {
    expect(inferBuckets('development-team', 'test-agent')).toEqual([
      'development',
    ]);
  });

  it('should map security to security', () => {
    expect(inferBuckets('security', 'security-auditor')).toEqual(['security']);
  });

  it('should map testing to testing-quality', () => {
    expect(inferBuckets('testing', 'test-runner')).toEqual(['testing-quality']);
  });

  it('should handle multi-bucket categories', () => {
    expect(inferBuckets('azure', 'azure-deploy')).toEqual([
      'devops-infra',
      'integrations',
    ]);
  });

  it('should handle database mapping to multiple buckets', () => {
    expect(inferBuckets('database', 'db-manager')).toEqual([
      'data-ai',
      'integrations',
    ]);
  });

  it('should map git-workflow to git-vcs', () => {
    expect(inferBuckets('git-workflow', 'branch-manager')).toEqual(['git-vcs']);
  });

  it('should map automation to automation', () => {
    expect(inferBuckets('automation', 'task-scheduler')).toEqual([
      'automation',
    ]);
  });

  it('should map documentation to documentation', () => {
    expect(inferBuckets('documentation', 'doc-writer')).toEqual([
      'documentation',
    ]);
  });
});

// =============================================================================
// Tests: inferBuckets - Category Normalization
// =============================================================================

describe('inferBuckets - category normalization', () => {
  it('should normalize underscores to hyphens', () => {
    expect(inferBuckets('browser_automation', 'test')).toEqual([
      'integrations',
      'automation',
    ]);
  });

  it('should normalize spaces to hyphens', () => {
    expect(inferBuckets('development team', 'test')).toEqual(['development']);
  });

  it('should be case insensitive', () => {
    expect(inferBuckets('SECURITY', 'test')).toEqual(['security']);
    expect(inferBuckets('Development-Team', 'test')).toEqual(['development']);
  });
});

// =============================================================================
// Tests: inferBuckets - Keyword Fallback
// =============================================================================

describe('inferBuckets - keyword fallback', () => {
  it('should infer from name when category is unknown', () => {
    const result = inferBuckets('unknown-category', 'react-component-builder');
    expect(result).toContain('development');
  });

  it('should infer from description', () => {
    const result = inferBuckets(undefined, 'helper', 'Runs unit tests');
    expect(result).toContain('testing-quality');
  });

  it('should infer multiple buckets from keywords', () => {
    const result = inferBuckets(
      undefined,
      'deploy-helper',
      'Deploy to AWS cloud'
    );
    expect(result).toContain('devops-infra');
  });

  it('should infer security from auth keyword', () => {
    const result = inferBuckets('misc', 'auth-manager', 'Handles authentication');
    expect(result).toContain('security');
  });

  it('should infer data-ai from ml keyword', () => {
    const result = inferBuckets(undefined, 'model-trainer', 'Train ML models');
    expect(result).toContain('data-ai');
  });

  it('should infer git-vcs from commit keyword', () => {
    const result = inferBuckets(undefined, 'commit-helper', 'Creates commits');
    expect(result).toContain('git-vcs');
  });

  it('should infer automation from workflow keyword', () => {
    const result = inferBuckets(undefined, 'workflow-runner', 'Automates tasks');
    expect(result).toContain('automation');
  });

  it('should infer integrations from slack keyword', () => {
    const result = inferBuckets(undefined, 'slack-notifier', 'Sends slack messages');
    expect(result).toContain('integrations');
  });
});

// =============================================================================
// Tests: inferBuckets - Uncategorized Fallback
// =============================================================================

describe('inferBuckets - uncategorized fallback', () => {
  it('should return uncategorized when no match found', () => {
    expect(inferBuckets('xyz', 'abc')).toEqual(['uncategorized']);
  });

  it('should return uncategorized for empty category', () => {
    expect(inferBuckets('', 'generic-thing')).toEqual(['uncategorized']);
  });

  it('should return uncategorized for undefined category and no keyword matches', () => {
    expect(inferBuckets(undefined, 'xyz123')).toEqual(['uncategorized']);
  });

  it('should never return empty array', () => {
    const result = inferBuckets(undefined, '', '');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('uncategorized');
  });
});

// =============================================================================
// Tests: getCategoryMapping
// =============================================================================

describe('getCategoryMapping', () => {
  it('should return mapping for known category', () => {
    expect(getCategoryMapping('security')).toEqual(['security']);
  });

  it('should return undefined for unknown category', () => {
    expect(getCategoryMapping('unknown-xyz')).toBeUndefined();
  });

  it('should normalize category before lookup', () => {
    expect(getCategoryMapping('Development_Team')).toEqual(['development']);
  });
});

// =============================================================================
// Tests: Edge Cases
// =============================================================================

describe('edge cases', () => {
  it('should handle very long category names', () => {
    const longCategory = 'z'.repeat(1000); // Use 'z' to avoid matching keywords
    const result = inferBuckets(longCategory, 'xyz123');
    // Since 'test' contains 'test' keyword, use different input
    expect(result).toEqual(['uncategorized']);
  });

  it('should handle special characters in name/description', () => {
    const result = inferBuckets(undefined, 'test@#$%', 'desc!@#$%');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should prioritize explicit mapping over keyword inference', () => {
    // 'security' category should map to 'security' bucket
    // even though 'api' keyword would suggest 'development'
    const result = inferBuckets('security', 'api-security-checker');
    expect(result).toEqual(['security']);
  });

  it('should handle undefined description', () => {
    const result = inferBuckets('security', 'test');
    expect(result).toEqual(['security']);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

const mockPoolQuery = vi.fn();
vi.mock('../../db', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

const mockSmartGenerate = vi.fn();
vi.mock('../../lib/anthropic-client', () => ({
  smartGenerate: (...args: unknown[]) => mockSmartGenerate(...args),
}));

import {
  runOptimizationAgent,
  analyzeExecutionData,
} from '../../services/optimization-agent';
import type { OptimizationReport } from '../../services/optimization-agent';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecutionSummary(overrides: Record<string, unknown> = {}) {
  return {
    deployment_id: 'deploy-1',
    system_slug: 'web-design-studio',
    total_executions: '42',
    avg_cost_usd: '0.50',
    total_cost_usd: '21.00',
    avg_duration_seconds: '45',
    failure_count: '3',
    timeout_count: '1',
    avg_qa_score: '0.88',
    model_usage: { 'claude-opus-4-20250514': 1 },
    ...overrides,
  };
}

function mockLlmAnalysis(
  recommendations: Array<{
    category: string;
    deploymentId?: string;
    systemSlug?: string;
    title?: string;
    description?: string;
    estimatedImpact?: string;
    currentCostUsd?: number;
    projectedCostUsd?: number;
    currentFailureRate?: number;
    avgQaScore?: number;
    suggestedChange?: string;
  }>
) {
  mockSmartGenerate.mockResolvedValueOnce({
    content: [{
      type: 'text',
      text: JSON.stringify({
        recommendations: recommendations.map((r) => ({
          deploymentId: 'deploy-1',
          systemSlug: 'web-design-studio',
          title: 'Test recommendation',
          description: 'Test description',
          estimatedImpact: 'Save ~$10/month',
          ...r,
        })),
      }),
    }],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Optimization Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Empty execution history
  // -------------------------------------------------------------------------
  describe('empty execution history', () => {
    it('returns empty report with no errors', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // fetchWeeklyExecutionSummary

      const report = await runOptimizationAgent();

      expect(report.totalExecutions).toBe(0);
      expect(report.totalCostUsd).toBe(0);
      expect(report.recommendations).toHaveLength(0);
      expect(report.autoAppliedCount).toBe(0);
      expect(report.pendingApprovalCount).toBe(0);
      expect(report.generatedAt).toBeDefined();
      expect(report.periodStart).toBeDefined();
      expect(report.periodEnd).toBeDefined();

      // Should NOT call LLM for empty data
      expect(mockSmartGenerate).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Recommendation categorization
  // -------------------------------------------------------------------------
  describe('recommendation categorization', () => {
    it('categorizes cost, reliability, and quality recommendations', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [makeExecutionSummary()],
      });

      mockLlmAnalysis([
        {
          category: 'cost',
          title: 'Downgrade model',
          currentCostUsd: 25,
          projectedCostUsd: 10,
        },
        {
          category: 'reliability',
          title: 'Increase timeout',
          currentFailureRate: 0.15,
          suggestedChange: 'Increase timeout to 300s',
        },
        {
          category: 'quality',
          title: 'Add prompt constraints',
          avgQaScore: 0.72,
          suggestedChange: 'Add output validation prompt',
        },
      ]);

      // 3 recordOperatorAction calls
      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const report = await runOptimizationAgent();

      expect(report.recommendations).toHaveLength(3);

      const costRec = report.recommendations.find((r) => r.category === 'cost');
      expect(costRec).toBeDefined();
      if (costRec && costRec.category === 'cost') {
        expect(costRec.currentCostUsd).toBe(25);
        expect(costRec.projectedCostUsd).toBe(10);
      }

      const reliabilityRec = report.recommendations.find((r) => r.category === 'reliability');
      expect(reliabilityRec).toBeDefined();
      if (reliabilityRec && reliabilityRec.category === 'reliability') {
        expect(reliabilityRec.currentFailureRate).toBe(0.15);
        expect(reliabilityRec.suggestedChange).toContain('timeout');
      }

      const qualityRec = report.recommendations.find((r) => r.category === 'quality');
      expect(qualityRec).toBeDefined();
      if (qualityRec && qualityRec.category === 'quality') {
        expect(qualityRec.avgQaScore).toBe(0.72);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Auto-apply logic: cost savings <=  $20/month → auto-apply
  // -------------------------------------------------------------------------
  describe('auto-apply logic', () => {
    it('auto-applies cost savings <= $20/month', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [makeExecutionSummary()],
      });

      // Weekly savings of $4 → monthly ~$16 → under $20 threshold → auto-apply
      mockLlmAnalysis([
        {
          category: 'cost',
          title: 'Minor model downgrade',
          currentCostUsd: 10,
          projectedCostUsd: 6,
          estimatedImpact: 'Save ~$16/month',
        },
      ]);

      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const report = await runOptimizationAgent();

      expect(report.autoAppliedCount).toBe(1);
      expect(report.pendingApprovalCount).toBe(0);
      expect(report.recommendations[0].riskLevel).toBe('auto-apply');
    });

    it('requires approval for cost savings > $20/month', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [makeExecutionSummary()],
      });

      // Weekly savings of $15 → monthly ~$60 → over $20 threshold → requires-approval
      mockLlmAnalysis([
        {
          category: 'cost',
          title: 'Major model downgrade',
          currentCostUsd: 25,
          projectedCostUsd: 10,
          estimatedImpact: 'Save ~$60/month',
        },
      ]);

      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const report = await runOptimizationAgent();

      expect(report.autoAppliedCount).toBe(0);
      expect(report.pendingApprovalCount).toBe(1);
      expect(report.recommendations[0].riskLevel).toBe('requires-approval');
    });

    it('auto-applies timeout/retry reliability changes', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [makeExecutionSummary()],
      });

      mockLlmAnalysis([
        {
          category: 'reliability',
          title: 'Increase timeout',
          currentFailureRate: 0.2,
          suggestedChange: 'Increase timeout to 300s',
        },
      ]);

      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const report = await runOptimizationAgent();

      expect(report.autoAppliedCount).toBe(1);
      expect(report.recommendations[0].riskLevel).toBe('auto-apply');
    });

    it('requires approval for structural reliability changes', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [makeExecutionSummary()],
      });

      mockLlmAnalysis([
        {
          category: 'reliability',
          title: 'Restructure pipeline',
          currentFailureRate: 0.3,
          suggestedChange: 'Split into two parallel pipelines for isolation',
        },
      ]);

      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const report = await runOptimizationAgent();

      expect(report.pendingApprovalCount).toBe(1);
      expect(report.recommendations[0].riskLevel).toBe('requires-approval');
    });

    it('always requires approval for quality/prompt rewrites', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [makeExecutionSummary()],
      });

      mockLlmAnalysis([
        {
          category: 'quality',
          title: 'Rewrite system prompt',
          avgQaScore: 0.65,
          suggestedChange: 'Complete prompt rewrite for better quality',
        },
      ]);

      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const report = await runOptimizationAgent();

      expect(report.pendingApprovalCount).toBe(1);
      expect(report.autoAppliedCount).toBe(0);
      expect(report.recommendations[0].riskLevel).toBe('requires-approval');
    });
  });

  // -------------------------------------------------------------------------
  // Auto-applied changes logged with approved=true
  // -------------------------------------------------------------------------
  describe('action logging', () => {
    it('logs auto-applied changes with approved=true', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [makeExecutionSummary()],
      });

      mockLlmAnalysis([
        {
          category: 'reliability',
          title: 'Add retry',
          currentFailureRate: 0.1,
          suggestedChange: 'Add retry on timeout',
        },
      ]);

      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      await runOptimizationAgent();

      // Find the INSERT INTO operator_actions call
      const insertCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes('INSERT INTO operator_actions')
      );
      expect(insertCall).toBeDefined();

      const params = insertCall![1] as unknown[];
      expect(params[1]).toBe('optimization');  // operator_type
      expect(params[2]).toBe('reliability');   // action_type (category)
      expect(params[6]).toBe(true);            // auto_applied
      expect(params[7]).toBe(true);            // approved = true for auto-applied
    });

    it('logs approval-required changes with approved=null', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [makeExecutionSummary()],
      });

      mockLlmAnalysis([
        {
          category: 'quality',
          title: 'Prompt improvement',
          avgQaScore: 0.6,
          suggestedChange: 'Rewrite the prompt entirely',
        },
      ]);

      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      await runOptimizationAgent();

      const insertCall = mockPoolQuery.mock.calls.find(
        (c: unknown[]) => (c[0] as string).includes('INSERT INTO operator_actions')
      );
      expect(insertCall).toBeDefined();

      const params = insertCall![1] as unknown[];
      expect(params[6]).toBe(false);  // auto_applied = false
      expect(params[7]).toBe(null);   // approved = null (pending)
    });
  });

  // -------------------------------------------------------------------------
  // Report aggregation
  // -------------------------------------------------------------------------
  describe('report aggregation', () => {
    it('aggregates total executions and cost from summaries', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          makeExecutionSummary({
            deployment_id: 'deploy-1',
            total_executions: '30',
            total_cost_usd: '15.00',
          }),
          makeExecutionSummary({
            deployment_id: 'deploy-2',
            system_slug: 'content-factory',
            total_executions: '12',
            total_cost_usd: '6.00',
          }),
        ],
      });

      mockLlmAnalysis([]);
      // No recordOperatorAction calls needed for empty recommendations

      const report = await runOptimizationAgent();

      expect(report.totalExecutions).toBe(42);
      expect(report.totalCostUsd).toBe(21);
    });
  });

  // -------------------------------------------------------------------------
  // analyzeExecutionData unit test
  // -------------------------------------------------------------------------
  describe('analyzeExecutionData', () => {
    it('calls LLM and parses recommendations', async () => {
      mockSmartGenerate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            recommendations: [
              {
                category: 'cost',
                deploymentId: 'deploy-1',
                systemSlug: 'test',
                title: 'Downgrade',
                description: 'Use Sonnet',
                estimatedImpact: 'Save $5/month',
                currentCostUsd: 10,
                projectedCostUsd: 5,
              },
            ],
          }),
        }],
      });

      const result = await analyzeExecutionData([makeExecutionSummary()]);

      expect(result.recommendations).toHaveLength(1);
      expect(result.recommendations[0].category).toBe('cost');
      expect(result.recommendations[0].currentCostUsd).toBe(10);
    });

    it('returns empty recommendations on invalid JSON', async () => {
      mockSmartGenerate.mockResolvedValue({
        content: [{ type: 'text', text: 'not valid json at all' }],
      });

      const result = await analyzeExecutionData([]);

      expect(result.recommendations).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Mixed auto-apply and approval-required
  // -------------------------------------------------------------------------
  describe('mixed risk levels', () => {
    it('correctly counts auto-applied and pending approval', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [makeExecutionSummary()],
      });

      mockLlmAnalysis([
        {
          category: 'cost',
          title: 'Small savings',
          currentCostUsd: 8,
          projectedCostUsd: 5,     // weekly $3 savings → monthly $12 → auto-apply
        },
        {
          category: 'reliability',
          title: 'Timeout increase',
          currentFailureRate: 0.1,
          suggestedChange: 'Increase timeout to 180s',  // timeout → auto-apply
        },
        {
          category: 'quality',
          title: 'Prompt rewrite',
          avgQaScore: 0.7,
          suggestedChange: 'Rewrite entire prompt',      // quality → requires-approval
        },
        {
          category: 'cost',
          title: 'Big savings',
          currentCostUsd: 50,
          projectedCostUsd: 20,    // weekly $30 savings → monthly $120 → requires-approval
        },
      ]);

      mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 1 });

      const report = await runOptimizationAgent();

      expect(report.autoAppliedCount).toBe(2);       // small cost + timeout
      expect(report.pendingApprovalCount).toBe(2);    // quality + big cost
      expect(report.recommendations).toHaveLength(4);
    });
  });
});

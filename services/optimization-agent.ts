// =============================================================================
// Optimization Agent — Weekly cron operator that analyzes execution history
// and generates cost, reliability, and quality recommendations.
// Low-risk changes are auto-applied; structural changes require approval.
// =============================================================================

import type Anthropic from '@anthropic-ai/sdk';
import { pool } from '../db';
import { smartGenerate } from '../lib/anthropic-client';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type RecommendationCategory = 'cost' | 'reliability' | 'quality';

type RiskLevel = 'auto-apply' | 'requires-approval';

interface BaseRecommendation {
  deploymentId: string;
  systemSlug: string;
  title: string;
  description: string;
  riskLevel: RiskLevel;
  estimatedImpact: string;
}

export type OptimizationRecommendation =
  | (BaseRecommendation & { category: 'cost'; currentCostUsd: number; projectedCostUsd: number })
  | (BaseRecommendation & { category: 'reliability'; currentFailureRate: number; suggestedChange: string })
  | (BaseRecommendation & { category: 'quality'; avgQaScore: number; suggestedChange: string });

export interface OptimizationReport {
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  totalExecutions: number;
  totalCostUsd: number;
  recommendations: OptimizationRecommendation[];
  autoAppliedCount: number;
  pendingApprovalCount: number;
}

interface ExecutionSummaryRow {
  deployment_id: string;
  system_slug: string;
  total_executions: string;
  avg_cost_usd: string | null;
  total_cost_usd: string | null;
  avg_duration_seconds: string | null;
  failure_count: string;
  timeout_count: string;
  avg_qa_score: string | null;
  model_usage: unknown;
}

interface LLMAnalysisResult {
  recommendations: Array<{
    category: RecommendationCategory;
    deploymentId: string;
    systemSlug: string;
    title: string;
    description: string;
    estimatedImpact: string;
    currentCostUsd?: number;
    projectedCostUsd?: number;
    currentFailureRate?: number;
    avgQaScore?: number;
    suggestedChange?: string;
  }>;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const AUTO_APPLY_COST_THRESHOLD_USD = 20;

// -----------------------------------------------------------------------------
// Database: Fetch past week's execution history
// -----------------------------------------------------------------------------

async function fetchWeeklyExecutionSummary(): Promise<ExecutionSummaryRow[]> {
  const { rows } = await pool.query<ExecutionSummaryRow>(
    `SELECT
       el.deployment_id,
       d.system_slug,
       COUNT(*)::text AS total_executions,
       AVG(el.cost_usd)::text AS avg_cost_usd,
       SUM(el.cost_usd)::text AS total_cost_usd,
       AVG(el.duration_seconds)::text AS avg_duration_seconds,
       COUNT(*) FILTER (WHERE el.status = 'failed')::text AS failure_count,
       COUNT(*) FILTER (WHERE el.error_message ILIKE '%timeout%')::text AS timeout_count,
       AVG((el.qa_scores->>'overall')::decimal)::text AS avg_qa_score,
       jsonb_object_agg(
         COALESCE(el.trigger_input->>'model', 'unknown'),
         1
       ) AS model_usage
     FROM execution_logs el
     JOIN deployments d ON d.id = el.deployment_id
     WHERE el.started_at >= now() - interval '7 days'
       AND d.status != 'archived'
     GROUP BY el.deployment_id, d.system_slug`
  );

  return rows;
}

// -----------------------------------------------------------------------------
// LLM Analysis (isolated for test mocking)
// -----------------------------------------------------------------------------

const ANALYSIS_SYSTEM_PROMPT = `You are an optimization analyst for an AI agent orchestration platform.
Analyze the execution data and produce specific, actionable recommendations in three categories:

1. COST: Identify systems where models can be downgraded (e.g., Opus → Sonnet) when quality is consistently high (QA > 0.9), or where execution frequency suggests batching.
2. RELIABILITY: Identify systems with high failure/timeout rates and suggest timeout increases, retry policies, or input validation.
3. QUALITY: Identify systems with low or declining QA scores and suggest prompt constraints, output validation, or model upgrades.

Return ONLY valid JSON with this shape:
{
  "recommendations": [
    {
      "category": "cost" | "reliability" | "quality",
      "deploymentId": "<uuid>",
      "systemSlug": "<slug>",
      "title": "<short title>",
      "description": "<detailed recommendation>",
      "estimatedImpact": "<e.g., 'Save ~$15/month' or 'Reduce failures by ~40%'>",
      "currentCostUsd": <number, cost category only>,
      "projectedCostUsd": <number, cost category only>,
      "currentFailureRate": <number 0-1, reliability category only>,
      "avgQaScore": <number 0-1, quality category only>,
      "suggestedChange": "<specific change, reliability/quality only>"
    }
  ]
}

If no recommendations exist for a category, omit entries for it. Return an empty array if the data shows no issues.`;

export async function analyzeExecutionData(
  summaries: ExecutionSummaryRow[]
): Promise<LLMAnalysisResult> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `Analyze this past week's execution data across deployed systems:\n\n${JSON.stringify(summaries, null, 2)}`,
    },
  ];

  const response = await smartGenerate('ARCHITECT', ANALYSIS_SYSTEM_PROMPT, messages);

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  try {
    return JSON.parse(text) as LLMAnalysisResult;
  } catch {
    return { recommendations: [] };
  }
}

// -----------------------------------------------------------------------------
// Risk Classification
// -----------------------------------------------------------------------------

function classifyRisk(rec: LLMAnalysisResult['recommendations'][number]): RiskLevel {
  if (rec.category === 'cost') {
    const savings = (rec.currentCostUsd ?? 0) - (rec.projectedCostUsd ?? 0);
    const monthlySavings = savings * 4; // weekly → monthly estimate
    if (monthlySavings > 0 && monthlySavings <= AUTO_APPLY_COST_THRESHOLD_USD) {
      return 'auto-apply';
    }
    return 'requires-approval';
  }

  if (rec.category === 'reliability') {
    // Timeout increases are low-risk
    const lower = rec.suggestedChange?.toLowerCase() ?? '';
    if (lower.includes('timeout') || lower.includes('retry')) {
      return 'auto-apply';
    }
    return 'requires-approval';
  }

  // Quality changes (prompt rewrites, model swaps) always require approval
  return 'requires-approval';
}

// -----------------------------------------------------------------------------
// Build typed recommendations
// -----------------------------------------------------------------------------

function buildRecommendation(
  raw: LLMAnalysisResult['recommendations'][number],
  riskLevel: RiskLevel
): OptimizationRecommendation {
  const base: BaseRecommendation = {
    deploymentId: raw.deploymentId,
    systemSlug: raw.systemSlug,
    title: raw.title,
    description: raw.description,
    riskLevel,
    estimatedImpact: raw.estimatedImpact,
  };

  switch (raw.category) {
    case 'cost':
      return { ...base, category: 'cost', currentCostUsd: raw.currentCostUsd ?? 0, projectedCostUsd: raw.projectedCostUsd ?? 0 };
    case 'reliability':
      return { ...base, category: 'reliability', currentFailureRate: raw.currentFailureRate ?? 0, suggestedChange: raw.suggestedChange ?? '' };
    case 'quality':
      return { ...base, category: 'quality', avgQaScore: raw.avgQaScore ?? 0, suggestedChange: raw.suggestedChange ?? '' };
  }
}

// -----------------------------------------------------------------------------
// Persist actions to operator_actions
// -----------------------------------------------------------------------------

async function recordOperatorAction(
  rec: OptimizationRecommendation,
  autoApplied: boolean
): Promise<void> {
  await pool.query(
    `INSERT INTO operator_actions
       (deployment_id, operator_type, action_type, description, before_state, after_state, auto_applied, approved)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
    [
      rec.deploymentId,
      'optimization',
      rec.category,
      `${rec.title}: ${rec.description}`,
      JSON.stringify({ estimatedImpact: rec.estimatedImpact }),
      JSON.stringify(rec),
      autoApplied,
      autoApplied ? true : null,
    ]
  );
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export async function runOptimizationAgent(): Promise<OptimizationReport> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Step 1: Fetch execution history
  const summaries = await fetchWeeklyExecutionSummary();

  if (summaries.length === 0) {
    return {
      generatedAt: now.toISOString(),
      periodStart: weekAgo.toISOString(),
      periodEnd: now.toISOString(),
      totalExecutions: 0,
      totalCostUsd: 0,
      recommendations: [],
      autoAppliedCount: 0,
      pendingApprovalCount: 0,
    };
  }

  const totalExecutions = summaries.reduce((sum, s) => sum + parseInt(s.total_executions, 10), 0);
  const totalCostUsd = summaries.reduce((sum, s) => sum + parseFloat(s.total_cost_usd ?? '0'), 0);

  // Step 2: Analyze with LLM
  const analysis = await analyzeExecutionData(summaries);

  // Step 3: Classify risk and build typed recommendations
  const recommendations: OptimizationRecommendation[] = analysis.recommendations.map((raw) => {
    const riskLevel = classifyRisk(raw);
    return buildRecommendation(raw, riskLevel);
  });

  // Step 4: Auto-apply low-risk, store approval-required as pending
  let autoAppliedCount = 0;
  let pendingApprovalCount = 0;

  for (const rec of recommendations) {
    const autoApplied = rec.riskLevel === 'auto-apply';
    await recordOperatorAction(rec, autoApplied);

    if (autoApplied) {
      autoAppliedCount++;
    } else {
      pendingApprovalCount++;
    }
  }

  // Step 5: Build report
  return {
    generatedAt: now.toISOString(),
    periodStart: weekAgo.toISOString(),
    periodEnd: now.toISOString(),
    totalExecutions,
    totalCostUsd,
    recommendations,
    autoAppliedCount,
    pendingApprovalCount,
  };
}

// =============================================================================
// QA Remediation Agent — Activates on QA FAIL events, identifies failed
// quality dimensions, patches responsible agent configs with auditor
// recommendations, and re-executes only affected pipeline phases.
// Max 3 iterations before escalating to user.
// =============================================================================

import type Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pool } from '../db';
import { smartGenerate } from '../lib/anthropic-client';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

const MAX_QA_ITERATIONS = 3;
const QA_PASS_THRESHOLD = 85;

/** Quality dimensions evaluated by the QA auditor. */
type QualityDimension =
  | 'Technical Quality'
  | 'Accessibility'
  | 'SEO'
  | 'Strategic Alignment'
  | 'Copy Quality'
  | 'Brand Consistency'
  | 'UX/Usability';

/** Discriminated union for remediation actions. */
export type RemediationAction =
  | { kind: 'patch'; dimension: QualityDimension; agentSlug: string; constraint: string; score: number }
  | { kind: 're-execute'; agentSlugs: string[]; iteration: number }
  | { kind: 'pass'; dimension: QualityDimension; score: number }
  | { kind: 'escalate'; reason: string; failedDimensions: FailedDimension[] };

export interface OperatorAction {
  deploymentId: string;
  operatorType: 'remediation';
  actionType: string;
  description: string;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  autoApplied: boolean;
}

interface ExecutionLog {
  id: string;
  deploymentId: string;
  systemSlug: string;
  qaScores: Record<string, number>;
  phasesTotal: number;
  outputUrl?: string;
}

interface FailedDimension {
  dimension: QualityDimension;
  score: number;
  agentSlug: string;
}

interface ExecutionLogRow {
  id: string;
  deployment_id: string;
  system_slug: string;
  qa_scores: Record<string, number>;
  phases_total: number;
  output_url: string | null;
}

interface LLMRemediationResult {
  patches: Array<{
    dimension: string;
    constraint: string;
  }>;
}

// -----------------------------------------------------------------------------
// Configurable mapping: quality dimension → responsible agent slug
// -----------------------------------------------------------------------------

const DIMENSION_TO_AGENT: Record<QualityDimension, string> = {
  'Technical Quality': 'frontend-engineer',
  'Accessibility': 'ux-ui-architect',
  'SEO': 'perf-seo-engineer',
  'Strategic Alignment': 'strategist',
  'Copy Quality': 'copywriter',
  'Brand Consistency': 'brand-designer',
  'UX/Usability': 'ux-ui-architect',
};

// -----------------------------------------------------------------------------
// Database: Fetch execution log with QA scores
// -----------------------------------------------------------------------------

async function fetchExecutionLog(executionId: string): Promise<ExecutionLog | null> {
  const { rows } = await pool.query<ExecutionLogRow>(
    `SELECT el.id, el.deployment_id, d.system_slug, el.qa_scores,
            el.phases_total, el.output_url
     FROM execution_logs el
     JOIN deployments d ON d.id = el.deployment_id
     WHERE el.id = $1`,
    [executionId]
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    systemSlug: row.system_slug,
    qaScores: row.qa_scores,
    phasesTotal: row.phases_total,
    outputUrl: row.output_url ?? undefined,
  };
}

// -----------------------------------------------------------------------------
// Identify failed dimensions
// -----------------------------------------------------------------------------

function identifyFailures(qaScores: Record<string, number>): FailedDimension[] {
  const failures: FailedDimension[] = [];

  for (const [dimension, score] of Object.entries(qaScores)) {
    if (dimension === 'overall') continue;

    const typedDimension = dimension as QualityDimension;
    const agentSlug = DIMENSION_TO_AGENT[typedDimension];
    if (!agentSlug) continue;

    if (score < QA_PASS_THRESHOLD) {
      failures.push({ dimension: typedDimension, score, agentSlug });
    }
  }

  return failures;
}

// -----------------------------------------------------------------------------
// LLM: Generate remediation constraints (isolated for test mocking)
// -----------------------------------------------------------------------------

const REMEDIATION_SYSTEM_PROMPT = `You are a QA remediation specialist for an AI agent pipeline.
Given failed quality dimensions and their scores, generate specific, actionable constraints
that should be injected into the responsible agent's system prompt to fix the issues.

Each constraint should be a clear directive that addresses the specific quality gap.
For example, if Accessibility scored 60/100, a constraint might be:
"Ensure all images have descriptive alt text, all form inputs have associated labels,
and color contrast ratios meet WCAG 2.1 AA standards (4.5:1 for normal text)."

Return ONLY valid JSON with this shape:
{
  "patches": [
    {
      "dimension": "<dimension name>",
      "constraint": "<specific constraint to inject into agent system prompt>"
    }
  ]
}`;

export async function generateRemediationConstraints(
  failures: FailedDimension[],
  qaScores: Record<string, number>
): Promise<LLMRemediationResult> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `The following quality dimensions failed (threshold: ${QA_PASS_THRESHOLD}/100):\n\n${JSON.stringify(failures, null, 2)}\n\nFull QA scores:\n${JSON.stringify(qaScores, null, 2)}\n\nGenerate targeted constraints for each failed dimension.`,
    },
  ];

  const response = await smartGenerate('ARCHITECT', REMEDIATION_SYSTEM_PROMPT, messages);

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  try {
    return JSON.parse(text) as LLMRemediationResult;
  } catch {
    return { patches: [] };
  }
}

// -----------------------------------------------------------------------------
// Patch agent configs on disk
// -----------------------------------------------------------------------------

async function patchAgentConfig(
  systemSlug: string,
  agentSlug: string,
  constraint: string,
  systemsRoot: string
): Promise<{ before: string; after: string }> {
  const claudeMdPath = path.join(
    systemsRoot, 'agents', systemSlug, agentSlug, 'CLAUDE.md'
  );

  let existing: string;
  try {
    existing = await fs.readFile(claudeMdPath, 'utf-8');
  } catch {
    existing = '';
  }

  const marker = '## QA Remediation Constraints';
  const constraintSection = `\n\n${marker}\n\n${constraint}\n`;

  // Replace existing remediation section or append
  let updated: string;
  if (existing.includes(marker)) {
    const markerIndex = existing.indexOf(marker);
    const nextSection = existing.indexOf('\n## ', markerIndex + marker.length);
    const before = existing.slice(0, markerIndex);
    const after = nextSection !== -1 ? existing.slice(nextSection) : '';
    updated = before + `${marker}\n\n${constraint}\n` + after;
  } else {
    updated = existing + constraintSection;
  }

  await fs.writeFile(claudeMdPath, updated, 'utf-8');

  return { before: existing, after: updated };
}

// -----------------------------------------------------------------------------
// Trigger partial re-execution via deploy bridge config update
// -----------------------------------------------------------------------------

async function triggerPartialReExecution(
  systemSlug: string,
  agentSlugs: string[]
): Promise<string> {
  // Insert a new execution_logs entry for the re-run
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO execution_logs (
       deployment_id, triggered_by, status, started_at
     )
     SELECT id, $2, $3, now()
     FROM deployments
     WHERE system_slug = $1 AND status != 'archived'
     RETURNING id`,
    [systemSlug, 'qa-remediation', 'running']
  );

  if (rows.length === 0) {
    throw new QaRemediationError(
      `No active deployment found for ${systemSlug}`,
      'trigger'
    );
  }

  const executionId = rows[0].id;

  // Update the deployment to signal which agents need re-execution
  await pool.query(
    `UPDATE deployments
     SET openclaw_config = jsonb_set(
       COALESCE(openclaw_config, '{}'::jsonb),
       '{partialReRun}',
       $1::jsonb
     ),
     updated_at = now()
     WHERE system_slug = $2 AND status != 'archived'`,
    [JSON.stringify({ agentSlugs, executionId }), systemSlug]
  );

  return executionId;
}

// -----------------------------------------------------------------------------
// Wait for re-execution to complete and fetch new QA scores
// -----------------------------------------------------------------------------

async function waitForReExecution(
  executionId: string,
  timeoutMs: number = 300_000
): Promise<Record<string, number> | null> {
  const pollIntervalMs = 5_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ status: string; qa_scores: Record<string, number> | null }>(
      `SELECT status, qa_scores FROM execution_logs WHERE id = $1`,
      [executionId]
    );

    if (rows.length === 0) return null;

    const { status, qa_scores } = rows[0];
    if (status === 'completed' && qa_scores) return qa_scores;
    if (status === 'failed') return null;

    await sleep(pollIntervalMs);
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// Persist actions to operator_actions
// -----------------------------------------------------------------------------

async function recordOperatorAction(action: OperatorAction): Promise<void> {
  await pool.query(
    `INSERT INTO operator_actions
       (deployment_id, operator_type, action_type, description,
        before_state, after_state, auto_applied, approved)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
    [
      action.deploymentId,
      action.operatorType,
      action.actionType,
      action.description,
      JSON.stringify(action.beforeState),
      JSON.stringify(action.afterState),
      action.autoApplied,
      action.autoApplied ? true : null,
    ]
  );
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export async function runQaRemediation(
  executionLog: ExecutionLog
): Promise<OperatorAction[]> {
  const systemsRoot =
    process.env.AUTOPILATE_SYSTEMS_ROOT ??
    process.env.OPENCLAW_ROOT ??
    './data/systems';
  const actions: OperatorAction[] = [];

  let currentScores = executionLog.qaScores;
  let iteration = 0;

  while (iteration < MAX_QA_ITERATIONS) {
    iteration++;

    // Step 1: Identify failed dimensions
    const failures = identifyFailures(currentScores);

    if (failures.length === 0) {
      console.log(`[qa-remediation] All dimensions pass at iteration ${iteration}`);
      break;
    }

    console.log(
      `[qa-remediation] Iteration ${iteration}/${MAX_QA_ITERATIONS}: ` +
      `${failures.length} dimension(s) failed`
    );

    // Step 2: Generate remediation constraints via LLM
    const remediation = await generateRemediationConstraints(failures, currentScores);

    // Step 3: Patch each failing agent's config
    const affectedAgentSlugs = new Set<string>();

    for (const failure of failures) {
      const patch = remediation.patches.find(
        (p) => p.dimension === failure.dimension
      );
      const constraint = patch?.constraint ?? `Improve ${failure.dimension} score (currently ${failure.score}/${QA_PASS_THRESHOLD} required).`;

      const { before, after } = await patchAgentConfig(
        executionLog.systemSlug,
        failure.agentSlug,
        constraint,
        systemsRoot
      );

      affectedAgentSlugs.add(failure.agentSlug);

      const action: OperatorAction = {
        deploymentId: executionLog.deploymentId,
        operatorType: 'remediation',
        actionType: 'patch',
        description: `Patched ${failure.agentSlug} for ${failure.dimension} (score: ${failure.score})`,
        beforeState: { config: before, score: failure.score },
        afterState: { config: after, constraint },
        autoApplied: true,
      };

      actions.push(action);
      await recordOperatorAction(action);
    }

    // Step 4: Re-execute only affected phases
    const agentSlugs = [...affectedAgentSlugs];
    const reExecutionId = await triggerPartialReExecution(
      executionLog.systemSlug,
      agentSlugs
    );

    const reRunAction: OperatorAction = {
      deploymentId: executionLog.deploymentId,
      operatorType: 'remediation',
      actionType: 're-execute',
      description: `Re-executing agents: ${agentSlugs.join(', ')} (iteration ${iteration})`,
      beforeState: { qaScores: currentScores, iteration },
      afterState: { executionId: reExecutionId, agentSlugs },
      autoApplied: true,
    };
    actions.push(reRunAction);
    await recordOperatorAction(reRunAction);

    // Step 5: Wait for re-execution results
    const newScores = await waitForReExecution(reExecutionId);

    if (!newScores) {
      const escalateAction: OperatorAction = {
        deploymentId: executionLog.deploymentId,
        operatorType: 'remediation',
        actionType: 'escalate',
        description: `Re-execution failed or timed out at iteration ${iteration}`,
        beforeState: { qaScores: currentScores, iteration },
        afterState: { executionId: reExecutionId },
        autoApplied: false,
      };
      actions.push(escalateAction);
      await recordOperatorAction(escalateAction);
      break;
    }

    currentScores = newScores;
  }

  // Step 6: Final check — escalate if still failing after max iterations
  const remainingFailures = identifyFailures(currentScores);

  if (remainingFailures.length > 0 && iteration >= MAX_QA_ITERATIONS) {
    const escalateAction: OperatorAction = {
      deploymentId: executionLog.deploymentId,
      operatorType: 'remediation',
      actionType: 'escalate',
      description: buildEscalationSummary(remainingFailures, iteration),
      beforeState: { qaScores: currentScores, iteration },
      afterState: { failedDimensions: remainingFailures },
      autoApplied: false,
    };
    actions.push(escalateAction);
    await recordOperatorAction(escalateAction);
  }

  return actions;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function buildEscalationSummary(
  failures: FailedDimension[],
  iterations: number
): string {
  const dims = failures
    .map((f) => `${f.dimension}: ${f.score}/${QA_PASS_THRESHOLD}`)
    .join(', ');
  return (
    `QA remediation exhausted after ${iterations} iterations. ` +
    `Still failing: ${dims}. Manual intervention required.`
  );
}

// Import + re-export typed error from shared
import { QaRemediationError } from '../lib/errors';
export { QaRemediationError };

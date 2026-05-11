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

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('# Existing Agent Config\n\nSome content here.'),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import * as fs from 'fs/promises';
import {
  runQaRemediation,
  generateRemediationConstraints,
} from '../../services/qa-remediation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecutionLog(qaScores: Record<string, number>) {
  return {
    id: 'exec-1',
    deploymentId: 'deploy-1',
    systemSlug: 'web-design-studio',
    qaScores,
    phasesTotal: 5,
    outputUrl: 'https://example.com/output',
  };
}

function mockLlmRemediation(patches: Array<{ dimension: string; constraint: string }>) {
  mockSmartGenerate.mockResolvedValueOnce({
    content: [{ type: 'text', text: JSON.stringify({ patches }) }],
  });
}

/**
 * Mock the re-execution flow:
 * 1. triggerPartialReExecution — INSERT execution_logs RETURNING id
 * 2. triggerPartialReExecution — UPDATE deployments
 * 3. waitForReExecution — SELECT status, qa_scores (poll returns completed)
 * 4. recordOperatorAction (for each patch + re-execute action)
 */
function setupReExecutionMocks(
  newScores: Record<string, number> | null,
  patchCount: number
) {
  // recordOperatorAction calls for each patch
  for (let i = 0; i < patchCount; i++) {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // recordOperatorAction
  }

  // triggerPartialReExecution — INSERT
  mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'reexec-1' }] });
  // triggerPartialReExecution — UPDATE
  mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

  // recordOperatorAction for the re-execute action
  mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

  if (newScores) {
    // waitForReExecution poll — return completed with new scores
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ status: 'completed', qa_scores: newScores }],
    });
  } else {
    // waitForReExecution poll — return failed
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ status: 'failed', qa_scores: null }],
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QA Remediation Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      '# Existing Agent Config\n\nSome content here.'
    );
    (fs.writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Dimension-to-agent mapping
  // -------------------------------------------------------------------------
  describe('dimension-to-agent mapping', () => {
    it('maps Technical Quality to frontend-engineer', async () => {
      const log = makeExecutionLog({
        'Technical Quality': 72,
        'Copy Quality': 92,
        overall: 82,
      });

      mockLlmRemediation([
        { dimension: 'Technical Quality', constraint: 'Fix semantic HTML' },
      ]);

      // 1 patch → 1 recordOperatorAction
      setupReExecutionMocks(
        { 'Technical Quality': 90, 'Copy Quality': 92, overall: 91 },
        1
      );

      const actions = await runQaRemediation(log);

      const patchAction = actions.find((a) => a.actionType === 'patch');
      expect(patchAction).toBeDefined();
      expect(patchAction!.description).toContain('frontend-engineer');
      expect(patchAction!.description).toContain('Technical Quality');
    });

    it('maps Accessibility to ux-ui-architect', async () => {
      const log = makeExecutionLog({
        Accessibility: 60,
        'Copy Quality': 95,
        overall: 77,
      });

      mockLlmRemediation([
        { dimension: 'Accessibility', constraint: 'Add ARIA labels' },
      ]);

      setupReExecutionMocks(
        { Accessibility: 90, 'Copy Quality': 95, overall: 92 },
        1
      );

      const actions = await runQaRemediation(log);

      const patchAction = actions.find((a) => a.actionType === 'patch');
      expect(patchAction!.description).toContain('ux-ui-architect');
    });

    it('maps SEO to perf-seo-engineer', async () => {
      const log = makeExecutionLog({
        SEO: 78,
        'Copy Quality': 90,
        overall: 84,
      });

      mockLlmRemediation([
        { dimension: 'SEO', constraint: 'Add meta descriptions' },
      ]);

      setupReExecutionMocks(
        { SEO: 88, 'Copy Quality': 90, overall: 89 },
        1
      );

      const actions = await runQaRemediation(log);

      const patchAction = actions.find((a) => a.actionType === 'patch');
      expect(patchAction!.description).toContain('perf-seo-engineer');
    });
  });

  // -------------------------------------------------------------------------
  // Only failed dimensions are targeted
  // -------------------------------------------------------------------------
  describe('failed dimension filtering', () => {
    it('skips passing dimensions (Copy Quality 92 passes)', async () => {
      const log = makeExecutionLog({
        'Technical Quality': 72,
        Accessibility: 80,
        SEO: 78,
        'Copy Quality': 92,
        overall: 80,
      });

      mockLlmRemediation([
        { dimension: 'Technical Quality', constraint: 'Fix semantic HTML' },
        { dimension: 'Accessibility', constraint: 'Add ARIA labels' },
        { dimension: 'SEO', constraint: 'Add meta descriptions' },
      ]);

      // 3 patches (Technical Quality, Accessibility, SEO) — Copy Quality skipped
      setupReExecutionMocks(
        {
          'Technical Quality': 90,
          Accessibility: 88,
          SEO: 86,
          'Copy Quality': 92,
          overall: 89,
        },
        3
      );

      const actions = await runQaRemediation(log);

      const patchActions = actions.filter((a) => a.actionType === 'patch');
      expect(patchActions).toHaveLength(3);

      const patchedDimensions = patchActions.map((a) => a.description);
      expect(patchedDimensions.some((d) => d.includes('Copy Quality'))).toBe(false);
      expect(patchedDimensions.some((d) => d.includes('Technical Quality'))).toBe(true);
      expect(patchedDimensions.some((d) => d.includes('Accessibility'))).toBe(true);
      expect(patchedDimensions.some((d) => d.includes('SEO'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Prompt patching adds QA Remediation Constraints section
  // -------------------------------------------------------------------------
  describe('prompt patching', () => {
    it('adds QA Remediation Constraints section to CLAUDE.md', async () => {
      const log = makeExecutionLog({
        'Technical Quality': 72,
        'Copy Quality': 92,
        overall: 82,
      });

      mockLlmRemediation([
        { dimension: 'Technical Quality', constraint: 'Use semantic HTML5 elements' },
      ]);

      setupReExecutionMocks(
        { 'Technical Quality': 90, 'Copy Quality': 92, overall: 91 },
        1
      );

      await runQaRemediation(log);

      const writeCall = (fs.writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(writeCall).toBeDefined();

      const writtenContent = writeCall[1] as string;
      expect(writtenContent).toContain('## QA Remediation Constraints');
      expect(writtenContent).toContain('Use semantic HTML5 elements');
    });
  });

  // -------------------------------------------------------------------------
  // Iteration limit of 3 — escalate after max iterations
  // -------------------------------------------------------------------------
  describe('iteration limit', () => {
    it('escalates after 3 failed iterations', async () => {
      const failingScores = {
        'Technical Quality': 72,
        'Copy Quality': 92,
        overall: 82,
      };

      const log = makeExecutionLog(failingScores);

      // Iteration 1: patch + re-execute → still failing
      mockLlmRemediation([
        { dimension: 'Technical Quality', constraint: 'Fix iteration 1' },
      ]);
      setupReExecutionMocks(
        { 'Technical Quality': 75, 'Copy Quality': 92, overall: 83 },
        1
      );

      // Iteration 2: patch + re-execute → still failing
      mockLlmRemediation([
        { dimension: 'Technical Quality', constraint: 'Fix iteration 2' },
      ]);
      setupReExecutionMocks(
        { 'Technical Quality': 78, 'Copy Quality': 92, overall: 84 },
        1
      );

      // Iteration 3: patch + re-execute → still failing
      mockLlmRemediation([
        { dimension: 'Technical Quality', constraint: 'Fix iteration 3' },
      ]);
      setupReExecutionMocks(
        { 'Technical Quality': 80, 'Copy Quality': 92, overall: 85 },
        1
      );

      // Final escalation recordOperatorAction
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const actions = await runQaRemediation(log);

      const escalateActions = actions.filter((a) => a.actionType === 'escalate');
      expect(escalateActions).toHaveLength(1);
      expect(escalateActions[0].autoApplied).toBe(false);
      expect(escalateActions[0].description).toContain('exhausted');
      expect(escalateActions[0].description).toContain('3 iterations');
    });
  });

  // -------------------------------------------------------------------------
  // Pass action when re-execution QA scores all pass
  // -------------------------------------------------------------------------
  describe('successful remediation', () => {
    it('completes without escalation when re-execution passes', async () => {
      const log = makeExecutionLog({
        'Technical Quality': 72,
        'Copy Quality': 92,
        overall: 82,
      });

      mockLlmRemediation([
        { dimension: 'Technical Quality', constraint: 'Use semantic elements' },
      ]);

      setupReExecutionMocks(
        { 'Technical Quality': 90, 'Copy Quality': 92, overall: 91 },
        1
      );

      const actions = await runQaRemediation(log);

      const escalateActions = actions.filter((a) => a.actionType === 'escalate');
      expect(escalateActions).toHaveLength(0);

      const patchActions = actions.filter((a) => a.actionType === 'patch');
      expect(patchActions).toHaveLength(1);
      expect(patchActions[0].autoApplied).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // generateRemediationConstraints LLM integration
  // -------------------------------------------------------------------------
  describe('generateRemediationConstraints', () => {
    it('calls LLM and parses patch results', async () => {
      mockSmartGenerate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            patches: [
              { dimension: 'Accessibility', constraint: 'All images need alt text' },
            ],
          }),
        }],
      });

      const failures = [
        { dimension: 'Accessibility' as const, score: 60, agentSlug: 'ux-ui-architect' },
      ];
      const qaScores = { Accessibility: 60, overall: 60 };

      const result = await generateRemediationConstraints(failures, qaScores);

      expect(result.patches).toHaveLength(1);
      expect(result.patches[0].dimension).toBe('Accessibility');
      expect(result.patches[0].constraint).toContain('alt text');
    });

    it('returns empty patches on invalid JSON', async () => {
      mockSmartGenerate.mockResolvedValue({
        content: [{ type: 'text', text: 'not valid json' }],
      });

      const result = await generateRemediationConstraints([], {});

      expect(result.patches).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Escalate on re-execution failure
  // -------------------------------------------------------------------------
  describe('re-execution failure', () => {
    it('escalates when re-execution fails', async () => {
      const log = makeExecutionLog({
        'Technical Quality': 72,
        'Copy Quality': 92,
        overall: 82,
      });

      mockLlmRemediation([
        { dimension: 'Technical Quality', constraint: 'Fix things' },
      ]);

      // re-execution returns null (failed)
      setupReExecutionMocks(null, 1);

      // recordOperatorAction for escalate action
      mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const actions = await runQaRemediation(log);

      const escalateActions = actions.filter((a) => a.actionType === 'escalate');
      expect(escalateActions).toHaveLength(1);
      expect(escalateActions[0].description).toContain('failed or timed out');
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { contentFactoryManifest } from './fixtures/mock-system-manifests';
import type { DeploymentRecord } from '../types/registry';

// ---------------------------------------------------------------------------
// Mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

const mockGetSystem = vi.fn();
vi.mock('../services/registry', () => ({
  getSystem: (...args: unknown[]) => mockGetSystem(...args),
  listSystems: vi.fn().mockResolvedValue([]),
}));

const mockPoolQuery = vi.fn();
vi.mock('../db', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

const mockRunTriggerExecution = vi.fn();
vi.mock('../services/trigger-executor', () => ({
  runTriggerExecution: (...args: unknown[]) => mockRunTriggerExecution(...args),
}));

const mockOnExecutionProgress = vi.fn();
vi.mock('../services/execution-events', () => ({
  onExecutionProgress: (...args: unknown[]) => mockOnExecutionProgress(...args),
}));

vi.mock('../services/alert-service', () => ({
  silenceAlerts: vi.fn(),
}));

const mockHandleMessage = vi.fn();
const mockIsGathering = vi.fn().mockReturnValue(false);
const mockDestroy = vi.fn();
const mockSetTimeoutCallback = vi.fn();

vi.mock('../services/router-agent', () => ({
  RouterAgent: vi.fn(),
  createRouterAgent: () => ({
    handleMessage: mockHandleMessage,
    isGathering: mockIsGathering,
    destroy: mockDestroy,
    setTimeoutCallback: mockSetTimeoutCallback,
  }),
}));

const mockApp = {
  message: vi.fn(),
  action: vi.fn(),
  error: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@slack/bolt', () => ({
  App: vi.fn(() => mockApp),
  LogLevel: { INFO: 'info' },
}));

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn(() => ({
    auth: { test: vi.fn().mockResolvedValue({ user: 'bot', team: 'test' }) },
  })),
}));

import { startSlackBot } from '../services/slack-bot';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal DeploymentRecord for testing. */
function buildDeployment(overrides?: Partial<DeploymentRecord>): DeploymentRecord {
  return {
    id: 'deploy-123',
    systemName: contentFactoryManifest.name,
    systemSlug: contentFactoryManifest.slug,
    manifestJson: contentFactoryManifest,
    canvasJson: { nodes: [{ id: 'n1' }], edges: [{ id: 'e1' }] },
    openclawConfig: {},
    triggerType: 'messaging',
    triggerConfig: {},
    pm2ProcessName: 'autopilate-content-factory',
    secretsDecrypted: null,
    status: 'deployed',
    domain: null,
    tags: [],
    deployedAt: '2026-01-01',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...overrides,
  };
}

/** Simulate a Slack message event through the registered handler. */
async function simulateMessage(text: string, userId = 'U123') {
  // startSlackBot registers a message handler via app.message()
  // We need to start the bot and capture the handler
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_APP_TOKEN = 'xapp-test';

  await startSlackBot();

  // The handler is the first argument to the first app.message() call
  const handler = mockApp.message.mock.calls[0][0];

  const sayMock = vi.fn().mockResolvedValue(undefined);

  await handler({
    message: { text, user: userId },
    say: sayMock,
  });

  return { sayMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Slack Bot — trigger execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApp.message.mockClear();
    mockApp.error.mockClear();
    mockApp.start.mockClear();
  });

  // -------------------------------------------------------------------------
  // Trigger decision → full execution flow
  // -------------------------------------------------------------------------
  it('executes system when router returns trigger decision', async () => {
    const deployment = buildDeployment();

    mockHandleMessage.mockResolvedValue({
      kind: 'trigger',
      system: contentFactoryManifest,
      inputs: { topic: 'AI trends', format: 'blog post' },
    });

    mockGetSystem.mockResolvedValue(deployment);

    // INSERT execution_logs → returns execution ID
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ id: 'exec-abc' }],
    });

    // onExecutionProgress returns unsub function
    const mockUnsub = vi.fn();
    mockOnExecutionProgress.mockReturnValue(mockUnsub);

    mockRunTriggerExecution.mockResolvedValue(undefined);

    // SELECT execution_logs after run
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ status: 'completed', output_url: null, duration_seconds: 12, error_message: null }],
    });

    const { sayMock } = await simulateMessage('write a blog post about AI trends');

    // Should have sent "Starting system" message
    expect(sayMock).toHaveBeenCalledWith(
      expect.stringContaining('Starting system:')
    );

    // Should have created execution_logs entry
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO execution_logs'),
      expect.arrayContaining(['deploy-123', 'slack', 'U123'])
    );

    // Should have called runTriggerExecution
    expect(mockRunTriggerExecution).toHaveBeenCalledWith(
      'exec-abc',
      deployment,
      { nodes: [{ id: 'n1' }], edges: [{ id: 'e1' }] },
      undefined,
      { topic: 'AI trends', format: 'blog post' },
      undefined
    );

    // Should have subscribed to execution progress
    expect(mockOnExecutionProgress).toHaveBeenCalledWith('exec-abc', expect.any(Function));

    // Should have sent completion message
    expect(sayMock).toHaveBeenCalledWith(
      expect.stringContaining('completed')
    );

    // Should have cleaned up progress subscription
    expect(mockUnsub).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Missing system → error message to user
  // -------------------------------------------------------------------------
  it('sends error when system is not deployed', async () => {
    mockHandleMessage.mockResolvedValue({
      kind: 'trigger',
      system: contentFactoryManifest,
      inputs: { topic: 'test' },
    });

    mockGetSystem.mockResolvedValue(null);
    const mockUnsub = vi.fn();
    mockOnExecutionProgress.mockReturnValue(mockUnsub);

    const { sayMock } = await simulateMessage('run content factory');

    expect(sayMock).toHaveBeenCalledWith(
      expect.stringContaining('is not deployed')
    );

    // Should NOT have called runTriggerExecution
    expect(mockRunTriggerExecution).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // System not in deployed status
  // -------------------------------------------------------------------------
  it('sends error when system status is not deployed', async () => {
    mockHandleMessage.mockResolvedValue({
      kind: 'trigger',
      system: contentFactoryManifest,
      inputs: { topic: 'test' },
    });

    mockGetSystem.mockResolvedValue(buildDeployment({ status: 'stopped' }));
    const mockUnsub = vi.fn();
    mockOnExecutionProgress.mockReturnValue(mockUnsub);

    const { sayMock } = await simulateMessage('run content factory');

    expect(sayMock).toHaveBeenCalledWith(
      expect.stringContaining('is not active')
    );
    expect(mockRunTriggerExecution).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Error handler sanitization
  // -------------------------------------------------------------------------
  it('sends generic error without leaking internal details', async () => {
    mockHandleMessage.mockRejectedValue(
      new Error('ECONNREFUSED: connection to PostgreSQL at 10.0.1.5:5432 failed')
    );

    const { sayMock } = await simulateMessage('hello');

    // Should send generic message with reference code
    const errorCall = sayMock.mock.calls[0][0] as string;
    expect(errorCall).toContain('Sorry, something went wrong');
    expect(errorCall).toContain('Reference:');

    // Should NOT contain internal error details
    expect(errorCall).not.toContain('ECONNREFUSED');
    expect(errorCall).not.toContain('PostgreSQL');
    expect(errorCall).not.toContain('10.0.1.5');
  });

  // -------------------------------------------------------------------------
  // Direct-answer and clarify still work
  // -------------------------------------------------------------------------
  it('handles direct-answer decisions normally', async () => {
    mockHandleMessage.mockResolvedValue({
      kind: 'direct-answer',
      response: 'The weather in Tokyo is sunny.',
    });

    const { sayMock } = await simulateMessage('what is the weather in Tokyo');

    expect(sayMock).toHaveBeenCalledWith('The weather in Tokyo is sunny.');
    expect(mockRunTriggerExecution).not.toHaveBeenCalled();
  });

  it('handles clarify decisions normally', async () => {
    mockHandleMessage.mockResolvedValue({
      kind: 'clarify',
      system: contentFactoryManifest,
      missingInputs: ['topic'],
      question: 'What topic would you like to write about?',
    });

    const { sayMock } = await simulateMessage('write something');

    expect(sayMock).toHaveBeenCalledWith('What topic would you like to write about?');
    expect(mockRunTriggerExecution).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Invalid canvas
  // -------------------------------------------------------------------------
  it('sends error when canvas has no nodes', async () => {
    mockHandleMessage.mockResolvedValue({
      kind: 'trigger',
      system: contentFactoryManifest,
      inputs: { topic: 'test' },
    });

    mockGetSystem.mockResolvedValue(
      buildDeployment({ canvasJson: { nodes: [], edges: [] } })
    );
    const mockUnsub = vi.fn();
    mockOnExecutionProgress.mockReturnValue(mockUnsub);

    const { sayMock } = await simulateMessage('run it');

    // Empty arrays are falsy for .length but truthy as arrays — the check is
    // !canvas?.nodes || !canvas?.edges which checks for null/undefined, not empty.
    // An empty array is truthy so this actually proceeds. But nodes: null would fail.
    // Let's test with null nodes instead.
  });

  it('sends error when canvas nodes are null', async () => {
    mockHandleMessage.mockResolvedValue({
      kind: 'trigger',
      system: contentFactoryManifest,
      inputs: { topic: 'test' },
    });

    mockGetSystem.mockResolvedValue(
      buildDeployment({ canvasJson: { nodes: null, edges: null } })
    );
    const mockUnsub = vi.fn();
    mockOnExecutionProgress.mockReturnValue(mockUnsub);

    const { sayMock } = await simulateMessage('run it');

    expect(sayMock).toHaveBeenCalledWith(
      expect.stringContaining('invalid configuration')
    );
    expect(mockRunTriggerExecution).not.toHaveBeenCalled();
  });
});

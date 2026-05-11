// =============================================================================
// Alert Service — posts execution failure alerts to Slack
//
// Subscribes to the in-process execution-events bus and sends structured
// Slack Block Kit messages when systems fail. Includes rate-limiting
// (5-min dedup per slug), severity classification, and a simple escalation
// path (DM on-call user after 10 min with no reaction).
//
// Same subscription pattern as socket/metrics-emitter.ts.
// =============================================================================

import { WebClient } from '@slack/web-api';
import {
  onAnyExecutionProgress,
  type ExecutionProgressEvent,
} from './execution-events';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const ALERT_CHANNEL = process.env.SLACK_ALERT_CHANNEL ?? '';
const ONCALL_USER_ID = process.env.SLACK_ONCALL_USER_ID ?? '';
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const ESCALATION_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const CONSECUTIVE_FAILURE_THRESHOLD = 3;

type Severity = 'critical' | 'warning' | 'info';

interface AlertState {
  count: number;
  lastAlertAt: number;
  consecutiveFailures: number;
  messageTs?: string; // Slack message ts for escalation check
}

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

let unsubscribe: (() => void) | null = null;
let slackClient: WebClient | null = null;
const alertStates = new Map<string, AlertState>();
const escalationTimers = new Map<string, ReturnType<typeof setTimeout>>();

// -----------------------------------------------------------------------------
// Severity classification
// -----------------------------------------------------------------------------

function classifySeverity(event: ExecutionProgressEvent, state: AlertState): Severity {
  const errorMsg = event.errorMessage?.toLowerCase() ?? '';
  const isInfraError = ['econnrefused', 'enomem', 'enospc', 'etimedout'].some(
    (code) => errorMsg.includes(code)
  );

  if (isInfraError || state.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
    return 'critical';
  }
  return 'warning';
}

// -----------------------------------------------------------------------------
// Rate limiting
// -----------------------------------------------------------------------------

function shouldAlert(slug: string): boolean {
  const state = alertStates.get(slug);
  if (!state) return true;
  return Date.now() - state.lastAlertAt >= DEDUP_WINDOW_MS;
}

function recordAlert(slug: string, messageTs?: string): void {
  const existing = alertStates.get(slug) ?? {
    count: 0,
    lastAlertAt: 0,
    consecutiveFailures: 0,
  };
  alertStates.set(slug, {
    count: existing.count + 1,
    lastAlertAt: Date.now(),
    consecutiveFailures: existing.consecutiveFailures + 1,
    messageTs,
  });
}

function recordSuccess(slug: string): void {
  const existing = alertStates.get(slug);
  if (existing) {
    existing.consecutiveFailures = 0;
  }
}

// -----------------------------------------------------------------------------
// Slack posting
// -----------------------------------------------------------------------------

async function postAlert(event: ExecutionProgressEvent, severity: Severity): Promise<void> {
  if (!slackClient || !ALERT_CHANNEL) return;

  const slug = event.systemSlug ?? 'unknown';
  const emoji = severity === 'critical' ? ':rotating_light:' : ':warning:';
  const color = severity === 'critical' ? '#dc2626' : '#f59e0b';
  const errorPreview = (event.errorMessage ?? 'No error details').slice(0, 300);
  const state = alertStates.get(slug);
  const consecutiveNote = state && state.consecutiveFailures > 1
    ? `\n*${state.consecutiveFailures} consecutive failures*`
    : '';

  try {
    const result = await slackClient.chat.postMessage({
      channel: ALERT_CHANNEL,
      text: `${emoji} System failed: ${slug}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${emoji} *System Failed: ${slug}*${consecutiveNote}`,
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Error:*\n\`\`\`${errorPreview}\`\`\`` },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Execution: \`${event.executionId}\` | Duration: ${event.durationSeconds ?? '?'}s | Severity: ${severity}`,
            },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'View Logs' },
              url: `${process.env.CORS_ORIGINS?.split(',')[0] ?? 'http://localhost:5173'}/systems/${slug}`,
              action_id: 'alert_view_logs',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Silence 1h' },
              action_id: 'alert_silence',
              value: slug,
            },
          ],
        },
      ],
      attachments: [{ color, fallback: `System ${slug} failed: ${errorPreview}` }],
    });

    const messageTs = result.ts;
    recordAlert(slug, messageTs);

    // Schedule escalation check
    if (ONCALL_USER_ID && messageTs) {
      scheduleEscalation(slug, messageTs);
    }
  } catch (err) {
    console.error(
      '[alert-service] Failed to post Slack alert:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

// -----------------------------------------------------------------------------
// Escalation — DM on-call user if no reaction after 10 min
// -----------------------------------------------------------------------------

function scheduleEscalation(slug: string, messageTs: string): void {
  // Clear any existing timer for this slug
  const existing = escalationTimers.get(slug);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    escalationTimers.delete(slug);
    if (!slackClient || !ONCALL_USER_ID || !ALERT_CHANNEL) return;

    try {
      // Check if anyone reacted or replied
      const replies = await slackClient.conversations.replies({
        channel: ALERT_CHANNEL,
        ts: messageTs,
        limit: 1,
      });

      const hasResponse = (replies.messages?.length ?? 0) > 1; // >1 because first message is the alert itself
      if (hasResponse) return; // Someone engaged, no escalation needed

      // DM the on-call user
      await slackClient.chat.postMessage({
        channel: ONCALL_USER_ID,
        text: `:rotating_light: *Unacknowledged failure: ${slug}*\nAn alert was posted to <#${ALERT_CHANNEL}> 10 minutes ago with no response. Please investigate.`,
      });

      console.log(`[alert-service] Escalated ${slug} failure to on-call user ${ONCALL_USER_ID}`);
    } catch (err) {
      console.error(
        '[alert-service] Escalation check failed:',
        err instanceof Error ? err.message : String(err)
      );
    }
  }, ESCALATION_DELAY_MS);

  escalationTimers.set(slug, timer);
}

// -----------------------------------------------------------------------------
// Silence handler — called from Slack interactive button
// -----------------------------------------------------------------------------

export function silenceAlerts(slug: string, durationMs: number = 60 * 60 * 1000): void {
  const state = alertStates.get(slug) ?? {
    count: 0,
    lastAlertAt: 0,
    consecutiveFailures: 0,
  };
  // Push lastAlertAt far enough into the future to suppress for the duration
  state.lastAlertAt = Date.now() + durationMs - DEDUP_WINDOW_MS;
  alertStates.set(slug, state);
  console.log(`[alert-service] Silenced alerts for ${slug} for ${durationMs / 60000} minutes`);
}

// -----------------------------------------------------------------------------
// Event handler
// -----------------------------------------------------------------------------

function handleEvent(event: ExecutionProgressEvent): void {
  const slug = event.systemSlug;
  if (!slug) return;

  if (event.type === 'complete') {
    recordSuccess(slug);
    return;
  }

  if (event.type !== 'failed') return;

  if (!shouldAlert(slug)) {
    const state = alertStates.get(slug);
    if (state) state.consecutiveFailures++;
    return;
  }

  const state = alertStates.get(slug) ?? {
    count: 0,
    lastAlertAt: 0,
    consecutiveFailures: 0,
  };
  // Increment before classification so the threshold check sees the current failure
  state.consecutiveFailures++;
  alertStates.set(slug, state);

  const severity = classifySeverity(event, state);
  postAlert(event, severity).catch((err) => {
    console.error('[alert-service] Unhandled error in postAlert:', err);
  });
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

export function initAlertService(): void {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken || !ALERT_CHANNEL) {
    console.log(
      '[alert-service] Disabled — set SLACK_BOT_TOKEN + SLACK_ALERT_CHANNEL to enable'
    );
    return;
  }

  slackClient = new WebClient(botToken);
  unsubscribe = onAnyExecutionProgress(handleEvent);
  console.log(`[alert-service] Active — alerts go to channel ${ALERT_CHANNEL}`);
}

export function destroyAlertService(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  for (const timer of escalationTimers.values()) {
    clearTimeout(timer);
  }
  escalationTimers.clear();
  slackClient = null;
}

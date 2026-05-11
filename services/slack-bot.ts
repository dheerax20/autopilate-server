// =============================================================================
// Slack Bot Service — Connects the Router Agent to Slack via Socket Mode.
// Uses @slack/bolt for real-time message handling.
// =============================================================================

import { App, LogLevel } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { RouterAgent, createRouterAgent, type RouterDecision } from './router-agent';
import { getSystem } from './registry';
import { pool } from '../db';
import { runTriggerExecution } from './trigger-executor';
import { onExecutionProgress } from './execution-events';
import { silenceAlerts } from './alert-service';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface SlackBotHandle {
  stop: () => Promise<void>;
}

// -----------------------------------------------------------------------------
// Channel → Domain mapping
//
// Parsed from SLACK_CHANNEL_DOMAINS env var. Format:
//   SLACK_CHANNEL_DOMAINS=C0123ABCD=research,C0456EFGH=content,C0789IJKL=development
//
// When a message arrives from a mapped channel, the router agent only
// considers systems deployed under that domain (+ global systems with
// domain=NULL). DMs and unmapped channels use an unscoped router that
// sees all deployed systems.
// -----------------------------------------------------------------------------

function parseChannelDomainMap(): Map<string, string> {
  const raw = process.env.SLACK_CHANNEL_DOMAINS ?? '';
  const map = new Map<string, string>();
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [channelId, domain] = entry.split('=').map((s) => s.trim());
    if (channelId && domain) {
      map.set(channelId, domain);
    }
  }
  if (map.size > 0) {
    console.log(`[SlackBot] Channel-domain mapping: ${map.size} channel(s) scoped`);
  }
  return map;
}

const channelDomainMap = parseChannelDomainMap();

// -----------------------------------------------------------------------------
// Per-user Router Agent Registry
// -----------------------------------------------------------------------------

// Key: "<userId>:<domain|*>" → RouterAgent instance (one per user per domain)
const userAgents = new Map<string, RouterAgent>();

function getOrCreateAgent(userId: string, domain?: string): RouterAgent {
  const key = `${userId}:${domain ?? '*'}`;
  let agent = userAgents.get(key);
  if (!agent) {
    const sessionId = domain
      ? `slack-${userId}-${domain}`
      : `slack-${userId}`;
    agent = createRouterAgent(sessionId, {
      silent: false,
      domain,
    });

    agent.setTimeoutCallback(() => {
      // Agent already sent the timeout message via socket emitter.
    });

    userAgents.set(key, agent);
  }
  return agent;
}

/** Remove idle agents to prevent memory leaks. Called periodically. */
function pruneIdleAgents(): void {
  for (const [userId, agent] of userAgents) {
    if (!agent.isGathering()) {
      agent.destroy();
      userAgents.delete(userId);
    }
  }
}

// -----------------------------------------------------------------------------
// Format Decision for Slack
// -----------------------------------------------------------------------------

function formatDecisionForSlack(decision: RouterDecision): string | null {
  switch (decision.kind) {
    case 'direct-answer':
      return decision.response;
    case 'clarify':
      return decision.question;
    case 'trigger':
      // Trigger decisions are handled directly in the message handler
      return null;
  }
}

// -----------------------------------------------------------------------------
// System Execution — triggers a deployed system through the shared
// trigger-executor → executeWorkflow → OrchestratorCore path, with
// Slack-specific progress reporting piped back to the channel.
// -----------------------------------------------------------------------------

/** Tracks systems currently executing via Slack (by userId:slug) to prevent double-triggers per user. */
const activeSlackExecutions = new Set<string>();

async function executeTriggeredSystemFromSlack(
  decision: Extract<RouterDecision, { kind: 'trigger' }>,
  userId: string,
  say: (msg: string) => Promise<unknown>
): Promise<void> {
  const systemSlug = decision.system.slug;
  const lockKey = `${userId}:${systemSlug}`;

  const system = await getSystem(systemSlug);
  if (!system) {
    await say(`System "${systemSlug}" is not deployed.`);
    return;
  }
  if (system.status !== 'deployed') {
    await say(`System "${systemSlug}" is not active (status: ${system.status}).`);
    return;
  }

  if (activeSlackExecutions.has(lockKey)) {
    await say(`System *${system.systemName}* is already executing, please wait.`);
    return;
  }

  const canvas = system.canvasJson as { nodes?: unknown[]; edges?: unknown[] };
  if (!canvas?.nodes || !canvas?.edges) {
    await say(`System "${system.systemName}" has invalid configuration.`);
    return;
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO execution_logs (
       deployment_id, triggered_by, triggered_by_user, trigger_input, status, started_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5, now())
     RETURNING id`,
    [
      system.id,
      'slack',
      userId,
      JSON.stringify({ inputs: decision.inputs }),
      'running',
    ]
  );
  const executionId = rows[0].id;

  activeSlackExecutions.add(lockKey);
  await say(`Starting system: *${system.systemName}*...`);
  console.log(`[SlackBot] Executing system "${systemSlug}" (id: ${executionId}) for user ${userId}`);

  let lastHeartbeatSentAt = 0;
  const HEARTBEAT_THROTTLE_MS = 30_000;

  const unsub = onExecutionProgress(executionId, (event) => {
    if (event.type === 'agent-started') {
      say(`Running agent: *${event.agentName}*...`).catch(() => {});
    } else if (event.type === 'heartbeat') {
      const now = Date.now();
      if (now - lastHeartbeatSentAt >= HEARTBEAT_THROTTLE_MS) {
        lastHeartbeatSentAt = now;
        say(`Still working on *${event.agentName}* (${event.elapsedSeconds}s)...`).catch(() => {});
      }
    } else if (event.type === 'phase-complete') {
      const idx = (event.phaseIndex ?? 0) + 1;
      const total = event.totalPhases ?? '?';
      say(`Phase ${idx}/${total} complete: ${event.phaseName}`).catch(() => {});
    }
  });

  try {
    await runTriggerExecution(
      executionId,
      system,
      canvas as { nodes: unknown[]; edges: unknown[] },
      undefined,
      decision.inputs,
      undefined
    );

    const { rows: logRows } = await pool.query<{
      status: string;
      output_url: string | null;
      duration_seconds: number | null;
      error_message: string | null;
    }>('SELECT status, output_url, duration_seconds, error_message FROM execution_logs WHERE id = $1', [executionId]);

    if (logRows.length > 0) {
      const log = logRows[0];
      if (log.status === 'failed') {
        await say(`System *${system.systemName}* failed.`);
      } else {
        const dur = log.duration_seconds != null ? ` in ${log.duration_seconds}s` : '';
        await say(`System *${system.systemName}* completed${dur}.`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[SlackBot] System execution failed for "${systemSlug}":`, msg);
    await say(`System *${system.systemName}* failed. Please check the dashboard for details.`);
  } finally {
    activeSlackExecutions.delete(lockKey);
    unsub();
  }
}

// -----------------------------------------------------------------------------
// Slack Bot Initialization
// -----------------------------------------------------------------------------

export async function startSlackBot(): Promise<SlackBotHandle> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) {
    throw new Error(
      '[SlackBot] Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN. '
      + 'Set both in server/.env to enable Slack integration.'
    );
  }

  // Validate the bot token before initializing Bolt to avoid unhandled
  // rejections inside Bolt's internal auth.test() call.
  const webClient = new WebClient(botToken);
  try {
    const authResult = await webClient.auth.test();
    console.log(`[SlackBot] Auth validated — bot user: ${authResult.user}, team: ${authResult.team}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[SlackBot] Bot token validation failed: ${msg}`);
  }

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  // Catch internal Bolt errors so they don't crash the server
  app.error(async (error) => {
    console.error('[SlackBot] Bolt error:', error.message ?? error);
  });

  // -------------------------------------------------------------------------
  // Alert action handlers (Block Kit interactive buttons)
  // -------------------------------------------------------------------------
  app.action('alert_silence', async ({ action, ack }) => {
    await ack();
    const slug = 'value' in action ? (action.value ?? '') : '';
    if (slug) {
      silenceAlerts(slug, 60 * 60 * 1000); // 1 hour
      console.log(`[SlackBot] Alert silenced for ${slug} (1h) via button`);
    }
  });

  app.action('alert_view_logs', async ({ ack }) => {
    await ack(); // URL button — Slack handles the navigation, we just ack
  });

  // -------------------------------------------------------------------------
  // Message Handler — routes all DMs and mentions through the RouterAgent
  // -------------------------------------------------------------------------
  app.message(async ({ message, say }) => {
    // Ignore bot messages, message_changed events, etc.
    if (message.subtype) return;
    if (!('text' in message) || !message.text) return;
    if (!message.user) return;

    const userId = message.user;
    const text = message.text.trim();

    if (!text) return;

    // Resolve domain from channel → domain mapping. DMs have channel_type
    // 'im' and no mapping — they get an unscoped router that sees all systems.
    const channelId = 'channel' in message ? (message.channel as string) : undefined;
    const domain = channelId ? channelDomainMap.get(channelId) : undefined;

    console.log(`[SlackBot] Message from ${userId} in ${channelId ?? 'DM'}${domain ? ` (domain: ${domain})` : ''}: "${text.slice(0, 100)}"`);

    const agent = getOrCreateAgent(userId, domain);

    try {
      const decision = await agent.handleMessage(text);

      console.log(`[SlackBot] Decision for ${userId}: ${decision.kind}`);
      logDecisionDetails(userId, text, decision);

      if (decision.kind === 'trigger') {
        await executeTriggeredSystemFromSlack(decision, userId, say);
        return;
      }

      const response = formatDecisionForSlack(decision);
      if (response) {
        await say(response);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorRef = Date.now().toString(36);
      console.error(`[SlackBot] Error ref ${errorRef} for ${userId}:`, errorMsg);
      await say(`Sorry, something went wrong processing your request. Reference: ${errorRef}`);
    }
  });

  // -------------------------------------------------------------------------
  // Start the Slack Socket Mode connection
  // -------------------------------------------------------------------------
  try {
    await app.start();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[SlackBot] Socket Mode connection failed: ${msg}`);
  }
  console.log('[SlackBot] Connected to Slack via Socket Mode');

  // Prune idle agents every 10 minutes
  const pruneInterval = setInterval(pruneIdleAgents, 10 * 60 * 1000);

  return {
    stop: async () => {
      clearInterval(pruneInterval);
      // Destroy all active agents
      for (const [, agent] of userAgents) {
        agent.destroy();
      }
      userAgents.clear();
      await app.stop();
      console.log('[SlackBot] Disconnected from Slack');
    },
  };
}

// -----------------------------------------------------------------------------
// Logging Helper
// -----------------------------------------------------------------------------

function logDecisionDetails(
  userId: string,
  message: string,
  decision: RouterDecision
): void {
  const prefix = `[SlackBot][${userId}]`;
  const msgPreview = message.slice(0, 80);

  switch (decision.kind) {
    case 'direct-answer':
      console.log(`${prefix} DIRECT ANSWER for "${msgPreview}"`);
      console.log(`${prefix}   Response: "${decision.response.slice(0, 120)}..."`);
      break;
    case 'clarify':
      console.log(`${prefix} CLARIFY for "${msgPreview}"`);
      console.log(`${prefix}   System: ${decision.system.name}`);
      console.log(`${prefix}   Missing: ${decision.missingInputs.join(', ')}`);
      break;
    case 'trigger':
      console.log(`${prefix} TRIGGER for "${msgPreview}"`);
      console.log(`${prefix}   System: ${decision.system.name}`);
      console.log(`${prefix}   Inputs: ${JSON.stringify(decision.inputs)}`);
      break;
  }
}

// =============================================================================
// Trigger Factory Service
// Generates OpenClaw trigger configurations based on bundle trigger patterns
// =============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { TriggerPattern, SystemManifest } from '../types/registry';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface CronTriggerConfig {
  type: 'cron';
  expression: string;
  timezone: string;
  enabled: boolean;
}

export interface WebhookTriggerConfig {
  type: 'webhook';
  endpointPath: string;
  method: 'POST';
  authType: 'bearer' | 'hmac' | 'none';
  secret?: string;
  enabled: boolean;
}

export interface MessagingTriggerConfig {
  type: 'messaging';
  channels: MessagingChannel[];
  routerEnabled: boolean;
  enabled: boolean;
}

export interface MessagingChannel {
  platform: 'whatsapp' | 'telegram' | 'slack' | 'discord';
  enabled: boolean;
}

export interface DaemonTriggerConfig {
  type: 'always-on';
  healthCheckIntervalMs: number;
  healthCheckEndpoint: string;
  enabled: boolean;
}

export type TriggerConfig =
  | CronTriggerConfig
  | WebhookTriggerConfig
  | MessagingTriggerConfig
  | DaemonTriggerConfig;

import { TriggerConfigError } from '../lib/errors';
export { TriggerConfigError };

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Create a trigger configuration and write it to the deployed-systems
 * config directory (<systemsRoot>/config/triggers/<slug>.json).
 */
export async function createTriggerConfig(
  triggerPattern: TriggerPattern,
  manifest: SystemManifest,
  systemsRoot: string
): Promise<TriggerConfig> {
  const config = buildTriggerConfig(triggerPattern, manifest);
  await writeTriggerConfig(config, manifest.slug, systemsRoot);
  return config;
}

/**
 * Remove trigger configuration files for a system.
 */
export async function removeTriggerConfig(
  systemSlug: string,
  systemsRoot: string
): Promise<void> {
  const triggerDir = path.join(systemsRoot, 'config', 'triggers');
  const filePath = path.join(triggerDir, `${systemSlug}.json`);
  await fs.rm(filePath, { force: true });
}

// -----------------------------------------------------------------------------
// Trigger builders — one function per trigger type
// -----------------------------------------------------------------------------

function buildTriggerConfig(
  pattern: TriggerPattern,
  manifest: SystemManifest
): TriggerConfig {
  switch (pattern) {
    case 'cron':
      return createCronTrigger(manifest);
    case 'webhook':
      return createWebhookTrigger(manifest);
    case 'messaging':
      return createMessagingTrigger(manifest);
    case 'always-on':
      return createDaemonTrigger(manifest);
    default: {
      const exhaustive: never = pattern;
      throw new TriggerConfigError(`Unknown trigger pattern: ${exhaustive}`);
    }
  }
}

function createCronTrigger(manifest: SystemManifest): CronTriggerConfig {
  // Default cron: daily at 6 AM UTC. Systems can override via config wizard.
  const expression = inferCronExpression(manifest.category);

  return {
    type: 'cron',
    expression,
    timezone: 'UTC',
    enabled: true,
  };
}

function createWebhookTrigger(manifest: SystemManifest): WebhookTriggerConfig {
  return {
    type: 'webhook',
    endpointPath: `/api/webhooks/${manifest.slug}`,
    method: 'POST',
    authType: 'bearer',
    enabled: true,
  };
}

function createMessagingTrigger(_manifest: SystemManifest): MessagingTriggerConfig {
  return {
    type: 'messaging',
    channels: [
      { platform: 'whatsapp', enabled: false },
      { platform: 'telegram', enabled: false },
      { platform: 'slack', enabled: true },
      { platform: 'discord', enabled: false },
    ],
    routerEnabled: true,
    enabled: true,
  };
}

function createDaemonTrigger(manifest: SystemManifest): DaemonTriggerConfig {
  return {
    type: 'always-on',
    healthCheckIntervalMs: 30_000,
    healthCheckEndpoint: `/health/${manifest.slug}`,
    enabled: true,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Infer a sensible default cron expression based on system category.
 */
function inferCronExpression(category: string): string {
  switch (category) {
    case 'monitoring':
      return '*/5 * * * *';      // every 5 minutes
    case 'data-analysis':
      return '0 */6 * * *';      // every 6 hours
    case 'content-production':
      return '0 6 * * 1-5';      // weekdays at 6 AM
    case 'research':
      return '0 0 * * *';        // daily at midnight
    default:
      return '0 6 * * *';        // daily at 6 AM
  }
}

/**
 * Write the trigger config JSON to <systemsRoot>/config/triggers/<slug>.json.
 */
async function writeTriggerConfig(
  config: TriggerConfig,
  systemSlug: string,
  systemsRoot: string
): Promise<void> {
  const triggerDir = path.join(systemsRoot, 'config', 'triggers');
  await fs.mkdir(triggerDir, { recursive: true });

  const filePath = path.join(triggerDir, `${systemSlug}.json`);
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import {
  createTriggerConfig,
  removeTriggerConfig,
  CronTriggerConfig,
  WebhookTriggerConfig,
  MessagingTriggerConfig,
  DaemonTriggerConfig,
  TriggerConfigError,
} from '../../services/trigger-factory';
import { createTestManifest } from './fixtures';
import { TriggerPattern, SystemCategory } from '../../types/registry';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

import * as fs from 'fs/promises';

const OPENCLAW_ROOT = '/opt/openclaw';

describe('Trigger Factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Cron trigger
  // ---------------------------------------------------------------------------
  describe('cron trigger', () => {
    it('generates a cron config with correct structure', async () => {
      const manifest = createTestManifest({ triggerPattern: 'cron', category: 'monitoring' });
      const config = await createTriggerConfig('cron', manifest, OPENCLAW_ROOT);

      expect(config.type).toBe('cron');
      expect(config.enabled).toBe(true);
      const cron = config as CronTriggerConfig;
      expect(cron.timezone).toBe('UTC');
      expect(typeof cron.expression).toBe('string');
    });

    it.each<[SystemCategory, string]>([
      ['monitoring', '*/5 * * * *'],
      ['data-analysis', '0 */6 * * *'],
      ['content-production', '0 6 * * 1-5'],
      ['research', '0 0 * * *'],
      ['web-development', '0 6 * * *'], // default
    ])('infers correct expression for category "%s"', async (category, expected) => {
      const manifest = createTestManifest({ triggerPattern: 'cron', category });
      const config = await createTriggerConfig('cron', manifest, OPENCLAW_ROOT) as CronTriggerConfig;

      expect(config.expression).toBe(expected);
    });

    it('writes config JSON to the correct path', async () => {
      const manifest = createTestManifest({ slug: 'my-sys', triggerPattern: 'cron' });
      await createTriggerConfig('cron', manifest, OPENCLAW_ROOT);

      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join(OPENCLAW_ROOT, 'config', 'triggers'),
        { recursive: true }
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        path.join(OPENCLAW_ROOT, 'config', 'triggers', 'my-sys.json'),
        expect.any(String),
        'utf-8'
      );

      // Verify written JSON parses correctly
      const written = JSON.parse((fs.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1]);
      expect(written.type).toBe('cron');
    });
  });

  // ---------------------------------------------------------------------------
  // Webhook trigger
  // ---------------------------------------------------------------------------
  describe('webhook trigger', () => {
    it('generates a webhook config with slug-based endpoint', async () => {
      const manifest = createTestManifest({ slug: 'data-fetcher', triggerPattern: 'webhook' });
      const config = await createTriggerConfig('webhook', manifest, OPENCLAW_ROOT) as WebhookTriggerConfig;

      expect(config.type).toBe('webhook');
      expect(config.endpointPath).toBe('/api/webhooks/data-fetcher');
      expect(config.method).toBe('POST');
      expect(config.authType).toBe('bearer');
      expect(config.enabled).toBe(true);
    });

    it('does not include a secret by default', async () => {
      const manifest = createTestManifest({ triggerPattern: 'webhook' });
      const config = await createTriggerConfig('webhook', manifest, OPENCLAW_ROOT) as WebhookTriggerConfig;

      expect(config.secret).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Messaging trigger
  // ---------------------------------------------------------------------------
  describe('messaging trigger', () => {
    it('generates messaging config with all four channels', async () => {
      const manifest = createTestManifest({ triggerPattern: 'messaging' });
      const config = await createTriggerConfig('messaging', manifest, OPENCLAW_ROOT) as MessagingTriggerConfig;

      expect(config.type).toBe('messaging');
      expect(config.routerEnabled).toBe(true);
      expect(config.enabled).toBe(true);
      expect(config.channels).toHaveLength(4);

      const platforms = config.channels.map((c) => c.platform);
      expect(platforms).toContain('whatsapp');
      expect(platforms).toContain('telegram');
      expect(platforms).toContain('slack');
      expect(platforms).toContain('discord');
    });

    it('enables only slack by default', async () => {
      const manifest = createTestManifest({ triggerPattern: 'messaging' });
      const config = await createTriggerConfig('messaging', manifest, OPENCLAW_ROOT) as MessagingTriggerConfig;

      const enabledChannels = config.channels.filter((c) => c.enabled);
      expect(enabledChannels).toHaveLength(1);
      expect(enabledChannels[0].platform).toBe('slack');
    });
  });

  // ---------------------------------------------------------------------------
  // Always-on (daemon) trigger
  // ---------------------------------------------------------------------------
  describe('always-on trigger', () => {
    it('generates daemon config with health check', async () => {
      const manifest = createTestManifest({ slug: 'my-daemon', triggerPattern: 'always-on' });
      const config = await createTriggerConfig('always-on', manifest, OPENCLAW_ROOT) as DaemonTriggerConfig;

      expect(config.type).toBe('always-on');
      expect(config.healthCheckIntervalMs).toBe(30_000);
      expect(config.healthCheckEndpoint).toBe('/health/my-daemon');
      expect(config.enabled).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // removeTriggerConfig
  // ---------------------------------------------------------------------------
  describe('removeTriggerConfig', () => {
    it('deletes the trigger config file', async () => {
      await removeTriggerConfig('my-sys', OPENCLAW_ROOT);

      expect(fs.rm).toHaveBeenCalledWith(
        path.join(OPENCLAW_ROOT, 'config', 'triggers', 'my-sys.json'),
        { force: true }
      );
    });
  });
});

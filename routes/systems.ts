// =============================================================================
// Systems API Routes
// =============================================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateBody } from '../src/middleware/validation';
import { AppError } from '../src/middleware/error-handler';
import { RateLimitError } from '../lib/errors';
import { pool } from '../db';
import {
  registerSystem,
  getSystem,
  listSystems,
  updateSystemStatus,
  updateSystemMetadata,
  archiveSystem,
  SystemNotFoundError,
} from '../services/registry';
import { runTriggerExecution } from '../services/trigger-executor';
import { executeWorkflow } from '../services/orchestrator-bridge';
import { isCallbackUrlSafe } from '../lib/url-validator';
import { randomUUID } from 'crypto';

// -----------------------------------------------------------------------------
// Zod Schemas
// -----------------------------------------------------------------------------

const systemManifestSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).max(128).regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  description: z.string(),
  version: z.string(),
  category: z.enum(['web-development', 'content-production', 'research', 'data-analysis', 'monitoring']),
  requiredInputs: z.array(z.object({
    name: z.string(),
    type: z.string(),
    description: z.string(),
    required: z.boolean(),
  })),
  outputType: z.enum(['web_artifact', 'document', 'data', 'notification']),
  estimatedCostUsd: z.number().min(0),
  triggerPattern: z.enum(['cron', 'webhook', 'messaging', 'always-on']),
  nodeCount: z.number().int().min(0),
  edgeCount: z.number().int().min(0),
});

const registerSystemBodySchema = z.object({
  manifest: systemManifestSchema,
  canvasJson: z.unknown(),
  agentConfigs: z.record(z.string(), z.unknown()),
  mcpConfigs: z.array(z.unknown()),
  pm2Ecosystem: z.unknown(),
  envExample: z.record(z.string(), z.string()),
  createdAt: z.string(),
});

const updateSystemBodySchema = z.object({
  status: z.enum(['deployed', 'stopped', 'errored']),
});

const patchSystemBodySchema = z.object({
  domain: z.string().max(64).nullable().optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
});

const testRunBodySchema = z.object({
  brief: z.string().min(1).optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
});

const triggerBodySchema = z.object({
  brief: z.string().min(1).optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  callbackUrl: z.string().url().optional().refine(
    (url) => !url || isCallbackUrlSafe(url).safe,
    { message: 'Callback URL is not allowed (private/internal address)' }
  ),
  triggeredBy: z.string().max(50).optional(),
});

// Per-system sliding window rate limiter (10 triggers/min per slug)
const triggerTimestamps = new Map<string, number[]>();

function triggerRateLimiter(req: Request, _res: Response, next: NextFunction): void {
  const slug = req.params.slug;
  const now = Date.now();
  const windowStart = now - 60_000;

  let timestamps = triggerTimestamps.get(slug);
  if (!timestamps) {
    timestamps = [];
    triggerTimestamps.set(slug, timestamps);
  }

  // Slide window
  while (timestamps.length > 0 && timestamps[0] <= windowStart) {
    timestamps.shift();
  }

  if (timestamps.length >= 10) {
    return next(new RateLimitError(`System "${slug}" trigger rate limit exceeded (10/min)`));
  }

  timestamps.push(now);
  next();
}

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

const router = Router();

// GET /api/systems — list all non-archived systems
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const systems = await listSystems();
    res.json({ systems });
  } catch (error) {
    next(error);
  }
});

// POST /api/systems — register a new system from a bundle
router.post(
  '/',
  validateBody(registerSystemBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const record = await registerSystem(req.body);
      res.status(201).json(record);
    } catch (error) {
      // Handle unique slug constraint violation
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === '23505'
      ) {
        return next(
          new AppError(409, `System with slug "${req.body.manifest.slug}" already exists`, 'DUPLICATE_SLUG')
        );
      }
      next(error);
    }
  }
);

// GET /api/systems/:slug — get a single system
router.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const record = await getSystem(req.params.slug);
    if (!record) {
      throw new AppError(404, `System "${req.params.slug}" not found`, 'NOT_FOUND');
    }
    res.json(record);
  } catch (error) {
    next(error);
  }
});

// PUT /api/systems/:slug — update system status
router.put(
  '/:slug',
  validateBody(updateSystemBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await updateSystemStatus(req.params.slug, req.body.status);
      res.json({ success: true });
    } catch (error) {
      // SystemNotFoundError is an AutopilateError with 404 status — pass through
      next(error);
    }
  }
);

// PATCH /api/systems/:slug — update organizational metadata (domain + tags)
router.patch(
  '/:slug',
  validateBody(patchSystemBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const record = await updateSystemMetadata(req.params.slug, req.body);
      res.json(record);
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /api/systems/:slug — archive a system (soft delete)
router.delete('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await archiveSystem(req.params.slug);
    res.status(204).send();
  } catch (error) {
    // SystemNotFoundError is an AutopilateError with 404 status — pass through
    next(error);
  }
});

// POST /api/systems/:slug/trigger — trigger system execution
router.post(
  '/:slug/trigger',
  triggerRateLimiter,
  validateBody(triggerBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug } = req.params;
      const { brief, inputs, callbackUrl, triggeredBy } = req.body;

      // Look up system (active only — getSystem excludes archived)
      const system = await getSystem(slug);
      if (!system) {
        throw new AppError(404, `System "${slug}" not found`, 'NOT_FOUND');
      }
      if (system.status !== 'deployed') {
        throw new AppError(
          409,
          `System "${slug}" is not deployed (status: ${system.status})`,
          'NOT_DEPLOYED'
        );
      }

      // Validate inputs against system's requiredInputs
      const manifest = system.manifestJson;
      const missing = manifest.requiredInputs
        .filter((ri) => ri.required && (!inputs || !(ri.name in inputs)))
        .map((ri) => ri.name);

      if (missing.length > 0) {
        throw new AppError(
          400,
          `Missing required inputs: ${missing.join(', ')}`,
          'MISSING_INPUTS'
        );
      }

      // Extract canvas state
      const canvas = system.canvasJson as { nodes?: unknown[]; edges?: unknown[] };
      if (!canvas?.nodes || !canvas?.edges) {
        throw new AppError(500, 'System has invalid canvas state', 'INVALID_CANVAS');
      }

      // Create execution_logs entry
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO execution_logs (
           deployment_id, triggered_by, trigger_input, status, started_at
         ) VALUES ($1, $2, $3::jsonb, $4, now())
         RETURNING id`,
        [system.id, triggeredBy || 'api', JSON.stringify({ brief, inputs }), 'running']
      );
      const executionId = rows[0].id;

      // Return immediately — execution happens asynchronously
      res.status(202).json({ executionId, status: 'running' });

      // Fire-and-forget: execute workflow, update logs, handle callback
      runTriggerExecution(
        executionId,
        system,
        canvas as { nodes: unknown[]; edges: unknown[] },
        brief,
        inputs,
        callbackUrl
      );
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/systems/:slug/test — run a system in Test Lab mode.
//
// Differences from /trigger:
//   - No row inserted into execution_logs (test runs are invisible to
//     production metrics + dashboards)
//   - No execution metrics recorded (metrics service is bypassed)
//   - No callback URL support
//   - Streams the same socket events (executionId is the sessionId), so the
//     Test Lab UI can subscribe and render the live trace.
//
// Returns 202 immediately with the sessionId. Execution runs fire-and-forget
// in the same Express process via executeWorkflow.
router.post(
  '/:slug/test',
  triggerRateLimiter,
  validateBody(testRunBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug } = req.params;
      const { brief, inputs } = req.body;

      const system = await getSystem(slug);
      if (!system) {
        throw new AppError(404, `System "${slug}" not found`, 'NOT_FOUND');
      }

      const canvas = system.canvasJson as { nodes?: unknown[]; edges?: unknown[] };
      if (!canvas?.nodes || !canvas?.edges) {
        throw new AppError(500, 'System has invalid canvas state', 'INVALID_CANVAS');
      }

      const sessionId = randomUUID();
      const briefText = brief || `Test execution: ${system.systemName}`;
      const fullBrief = inputs
        ? `${briefText}\n\nInputs:\n${JSON.stringify(inputs, null, 2)}`
        : briefText;

      // Acknowledge immediately so the frontend can subscribe to socket events
      res.status(202).json({ sessionId, status: 'running' });

      // Fire-and-forget. No execution_logs writes — Test Lab is sandboxed.
      executeWorkflow(
        sessionId,
        canvas.nodes as Parameters<typeof executeWorkflow>[1],
        canvas.edges as Parameters<typeof executeWorkflow>[2],
        fullBrief,
        system.systemName,
      ).catch((err) => {
        console.error(`[test-run] ${slug} (${sessionId}) failed:`, err);
      });
    } catch (error) {
      next(error);
    }
  }
);

export { router as systemsRouter };

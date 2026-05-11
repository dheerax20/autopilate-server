// =============================================================================
// Deploy API Route
// Accepts a SystemBundle and runs the full deploy bridge pipeline
// =============================================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateBody } from '../src/middleware/validation';
import { AppError } from '../src/middleware/error-handler';
import { deploySystem, DeployError } from '../services/deploy-bridge';

// -----------------------------------------------------------------------------
// Zod Schema (mirrors the systems register schema)
// -----------------------------------------------------------------------------

const deployBodySchema = z.object({
  manifest: z.object({
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
  }),
  canvasJson: z.unknown(),
  agentConfigs: z.record(z.string(), z.unknown()),
  mcpConfigs: z.array(z.unknown()),
  pm2Ecosystem: z.unknown(),
  envExample: z.record(z.string(), z.string()),
  createdAt: z.string(),
});

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

const router = Router();

// POST /api/deploy — register a system bundle with the AUTOPILATE server
router.post(
  '/',
  validateBody(deployBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Where deploy-bridge writes on-disk per-system config (agents/,
      // config/mcp/, config/triggers/). Honors the legacy OPENCLAW_ROOT
      // env var so existing deployments upgrade cleanly.
      const systemsRoot =
        process.env.AUTOPILATE_SYSTEMS_ROOT ||
        process.env.OPENCLAW_ROOT ||
        './data/systems';
      const record = await deploySystem(req.body, systemsRoot);
      res.status(201).json(record);
    } catch (error) {
      // DeployError (DeploymentError) is an AutopilateError — the centralized
      // error handler will format it correctly. Pass through directly.
      if (error instanceof DeployError) {
        return next(error);
      }
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

export { router as deployRouter };

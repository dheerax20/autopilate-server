// =============================================================================
// Templates Marketplace API Routes
// =============================================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateBody } from '../src/middleware/validation';
import { AppError } from '../src/middleware/error-handler';
import {
  listTemplates,
  getTemplate,
  publishTemplate,
  installTemplate,
  publishFromDeployment,
  archiveTemplate,
  TemplateNotFoundError,
} from '../services/template-service';

// -----------------------------------------------------------------------------
// Zod Schemas
// -----------------------------------------------------------------------------

const publishTemplateBodySchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).max(128).regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  description: z.string().min(1),
  longDescription: z.string().optional(),
  category: z.string().min(1),
  tags: z.array(z.string()).optional(),
  version: z.string().optional(),
  author: z.string().optional(),
  manifestJson: z.unknown(),
  canvasJson: z.unknown(),
  agentConfigs: z.unknown().optional(),
  mcpConfigs: z.unknown().optional(),
  envExample: z.record(z.string(), z.string()).optional(),
  outputType: z.string().optional(),
  triggerPattern: z.string().optional(),
  estimatedCostUsd: z.number().min(0).optional(),
  nodeCount: z.number().int().min(0).optional(),
  edgeCount: z.number().int().min(0).optional(),
});

const publishFromDeploymentBodySchema = z.object({
  deploymentSlug: z.string().min(1),
  longDescription: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

const router = Router();

// GET /api/templates — browse published templates
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const category = req.query.category as string | undefined;
    const tagsRaw = req.query.tags as string | undefined;
    const search = req.query.search as string | undefined;
    const sort = req.query.sort as string | undefined;
    const limitRaw = req.query.limit as string | undefined;
    const offsetRaw = req.query.offset as string | undefined;

    const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    const sortBy = (sort === 'newest' || sort === 'rating') ? sort : 'popular';
    const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 20, 1), 100) : 20;
    const offset = offsetRaw ? Math.max(parseInt(offsetRaw, 10) || 0, 0) : 0;

    const result = await listTemplates({ category, tags, search, sortBy, limit, offset });

    res.json({
      templates: result.templates,
      total: result.total,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/templates/:slug — get a single template
router.get('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const template = await getTemplate(req.params.slug);
    if (!template) {
      throw new AppError(404, `Template "${req.params.slug}" not found`, 'NOT_FOUND');
    }
    res.json(template);
  } catch (error) {
    next(error);
  }
});

// POST /api/templates — publish a new template
router.post(
  '/',
  validateBody(publishTemplateBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const record = await publishTemplate(req.body);
      res.status(201).json(record);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === '23505'
      ) {
        return next(
          new AppError(409, `Template with slug "${req.body.slug}" already exists`, 'DUPLICATE_SLUG')
        );
      }
      next(error);
    }
  }
);

// POST /api/templates/from-deployment — publish from an existing deployment
router.post(
  '/from-deployment',
  validateBody(publishFromDeploymentBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { deploymentSlug, longDescription, tags } = req.body;
      const record = await publishFromDeployment(deploymentSlug, { longDescription, tags });
      res.status(201).json(record);
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/templates/:slug/install — install a template as a new deployment
router.post('/:slug/install', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await installTemplate(req.params.slug);
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof TemplateNotFoundError) {
      return next(new AppError(404, error.message, 'NOT_FOUND'));
    }
    next(error);
  }
});

// DELETE /api/templates/:slug — archive a template (soft delete)
router.delete('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await archiveTemplate(req.params.slug);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export { router as templatesRouter };

// =============================================================================
// Workspaces API Routes
//
// Per-workspace canvas storage. Each team member picks a workspace name in
// the header (e.g., "reed", "alice", "experiments") and their canvas is
// isolated to that workspace's file. Two members on different workspaces
// never collide.
//
// The workspace concept is intentionally narrow — only the canvas state is
// scoped per workspace. Systems, Discover, Vault, and credentials remain
// team-shared because those are the resources you WANT shared.
// =============================================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateBody } from '../src/middleware/validation';
import { AppError } from '../src/middleware/error-handler';
import {
  listWorkspaces,
  getWorkspaceCanvas,
  saveWorkspaceCanvas,
  createWorkspace,
  deleteWorkspace,
  isValidSlug,
} from '../services/workspace-store';

const createWorkspaceSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'slug must be lowercase alphanumeric + hyphens, 1-64 chars'),
  label: z.string().min(1).max(120).optional(),
});

const saveCanvasSchema = z.object({
  nodes: z.array(z.unknown()),
  edges: z.array(z.unknown()),
});

const router = Router();

/**
 * GET /api/workspaces
 *
 * List every workspace with metadata for the switcher dropdown.
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaces = await listWorkspaces();
    res.json({ workspaces });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/workspaces
 *
 * Create a new workspace with an empty canvas. Slug must be unique.
 */
router.post(
  '/',
  validateBody(createWorkspaceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug, label } = req.body as { slug: string; label?: string };
      const workspace = await createWorkspace(slug, label);
      res.status(201).json(workspace);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create workspace';
      if (message.includes('already exists')) {
        return next(new AppError(409, message, 'WORKSPACE_EXISTS'));
      }
      next(error);
    }
  }
);

/**
 * GET /api/workspaces/:slug/canvas
 *
 * Read the canvas (nodes + edges) for a workspace. Returns an empty canvas
 * if the workspace exists but has no saved state yet.
 */
router.get('/:slug/canvas', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isValidSlug(req.params.slug)) {
      throw new AppError(400, 'Invalid workspace slug', 'INVALID_SLUG');
    }
    const canvas = await getWorkspaceCanvas(req.params.slug);
    res.json(canvas);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/workspaces/:slug/canvas
 *
 * Save the canvas (nodes + edges) for a workspace. Replaces whatever was
 * there. Last write wins — concurrent edits within the same workspace will
 * overwrite each other (which is fine because the team's expected workflow
 * is "one workspace per person" rather than "real-time collaboration in the
 * same workspace").
 */
router.put(
  '/:slug/canvas',
  validateBody(saveCanvasSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isValidSlug(req.params.slug)) {
        throw new AppError(400, 'Invalid workspace slug', 'INVALID_SLUG');
      }
      const { nodes, edges } = req.body as { nodes: unknown[]; edges: unknown[] };
      await saveWorkspaceCanvas(req.params.slug, { nodes, edges });
      res.json({ saved: true, nodeCount: nodes.length, edgeCount: edges.length });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/workspaces/:slug
 *
 * Hard-delete a workspace + its canvas file. The "default" workspace cannot
 * be deleted (the rest of the app expects it to exist).
 */
router.delete('/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isValidSlug(req.params.slug)) {
      throw new AppError(400, 'Invalid workspace slug', 'INVALID_SLUG');
    }
    await deleteWorkspace(req.params.slug);
    res.status(204).send();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete workspace';
    if (message.includes('Cannot delete the default')) {
      return next(new AppError(400, message, 'CANNOT_DELETE_DEFAULT'));
    }
    if (message.includes('not found')) {
      return next(new AppError(404, message, 'WORKSPACE_NOT_FOUND'));
    }
    next(error);
  }
});

export { router as workspacesRouter };

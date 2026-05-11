// =============================================================================
// Operator Actions API Routes
// CRUD routes for managing operator actions (monitor, QA, optimization)
// =============================================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { pool } from '../db';
import { AppError } from '../src/middleware/error-handler';
import { restartProcess } from '../services/pm2-manager';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface OperatorActionRow {
  id: string;
  deployment_id: string;
  operator_type: string;
  action_type: string;
  description: string;
  before_state: unknown;
  after_state: unknown;
  auto_applied: boolean;
  approved: boolean | null;
  created_at: string;
  system_slug: string | null;
}

interface CountRow {
  count: string;
}

// -----------------------------------------------------------------------------
// Zod Schemas
// -----------------------------------------------------------------------------

const listQuerySchema = z.object({
  operator_type: z
    .enum(['system_monitor', 'remediation', 'optimization'])
    .optional(),
  approved: z.enum(['true', 'false']).optional(),
  system_slug: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 50))
    .pipe(z.number().int().min(1).max(200)),
  offset: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 0))
    .pipe(z.number().int().min(0)),
});

const actionIdSchema = z.object({
  id: z.string().uuid(),
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function formatRow(row: OperatorActionRow) {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    systemSlug: row.system_slug,
    operatorType: row.operator_type,
    actionType: row.action_type,
    description: row.description,
    beforeState: row.before_state,
    afterState: row.after_state,
    autoApplied: row.auto_applied,
    approved: row.approved,
    createdAt: row.created_at,
  };
}

const ACTION_SELECT = `
  SELECT oa.id, oa.deployment_id, oa.operator_type, oa.action_type,
         oa.description, oa.before_state, oa.after_state,
         oa.auto_applied, oa.approved, oa.created_at,
         d.system_slug
  FROM operator_actions oa
  LEFT JOIN deployments d ON d.id = oa.deployment_id`;

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

const router = Router();

// GET /api/operators/actions — list recent actions with optional filters
router.get('/actions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, 'Invalid query parameters', 'VALIDATION_ERROR');
    }

    const { operator_type, approved, system_slug, limit, offset } = parsed.data;
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (operator_type) {
      conditions.push(`oa.operator_type = $${idx++}`);
      params.push(operator_type);
    }
    if (approved !== undefined) {
      conditions.push(`oa.approved = $${idx++}`);
      params.push(approved === 'true');
    }
    if (system_slug) {
      conditions.push(`d.system_slug = $${idx++}`);
      params.push(system_slug);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countParams = [...params];

    params.push(limit);
    const limitIdx = idx++;
    params.push(offset);
    const offsetIdx = idx;

    const { rows } = await pool.query<OperatorActionRow>(
      `${ACTION_SELECT} ${where} ORDER BY oa.created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    const { rows: countRows } = await pool.query<CountRow>(
      `SELECT COUNT(*)::text AS count
       FROM operator_actions oa
       LEFT JOIN deployments d ON d.id = oa.deployment_id
       ${where}`,
      countParams
    );

    res.json({
      actions: rows.map(formatRow),
      total: parseInt(countRows[0].count, 10),
      limit,
      offset,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/operators/actions/pending — list pending approvals
router.get(
  '/actions/pending',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const systemSlug = typeof req.query.system_slug === 'string'
        ? req.query.system_slug
        : undefined;

      const conditions = ['oa.approved IS NULL'];
      const params: unknown[] = [];

      if (systemSlug) {
        conditions.push('d.system_slug = $1');
        params.push(systemSlug);
      }

      const { rows } = await pool.query<OperatorActionRow>(
        `${ACTION_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY oa.created_at DESC`,
        params
      );

      res.json({ actions: rows.map(formatRow) });
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/operators/actions/:id/approve — approve and apply a pending action
router.post(
  '/actions/:id/approve',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paramParsed = actionIdSchema.safeParse(req.params);
      if (!paramParsed.success) {
        throw new AppError(400, 'Invalid action ID', 'VALIDATION_ERROR');
      }

      const { id } = paramParsed.data;

      const { rows } = await pool.query<OperatorActionRow>(
        `${ACTION_SELECT} WHERE oa.id = $1`,
        [id]
      );

      if (rows.length === 0) {
        throw new AppError(404, `Action "${id}" not found`, 'NOT_FOUND');
      }

      const action = rows[0];
      if (action.approved !== null) {
        throw new AppError(
          409,
          `Action already ${action.approved ? 'approved' : 'rejected'}`,
          'ALREADY_RESOLVED'
        );
      }

      await pool.query(
        `UPDATE operator_actions SET approved = true WHERE id = $1`,
        [id]
      );

      await applyApprovedAction(action);

      res.json({
        success: true,
        action: formatRow({ ...action, approved: true }),
      });
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/operators/actions/:id/reject — reject a pending action
router.post(
  '/actions/:id/reject',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paramParsed = actionIdSchema.safeParse(req.params);
      if (!paramParsed.success) {
        throw new AppError(400, 'Invalid action ID', 'VALIDATION_ERROR');
      }

      const { id } = paramParsed.data;

      const { rows } = await pool.query<{ id: string; approved: boolean | null }>(
        `SELECT id, approved FROM operator_actions WHERE id = $1`,
        [id]
      );

      if (rows.length === 0) {
        throw new AppError(404, `Action "${id}" not found`, 'NOT_FOUND');
      }

      if (rows[0].approved !== null) {
        throw new AppError(
          409,
          `Action already ${rows[0].approved ? 'approved' : 'rejected'}`,
          'ALREADY_RESOLVED'
        );
      }

      await pool.query(
        `UPDATE operator_actions SET approved = false WHERE id = $1`,
        [id]
      );

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

// -----------------------------------------------------------------------------
// Apply approved action: update deployment config and restart process
// -----------------------------------------------------------------------------

async function applyApprovedAction(action: OperatorActionRow): Promise<void> {
  if (!action.deployment_id) return;

  const afterState = action.after_state as Record<string, unknown> | null;
  if (!afterState) return;

  // Optimization recommendations: merge config into deployment
  if (action.operator_type === 'optimization') {
    await pool.query(
      `UPDATE deployments
       SET openclaw_config = COALESCE(openclaw_config, '{}'::jsonb) || $1::jsonb,
           updated_at = now()
       WHERE id = $2`,
      [JSON.stringify({ approvedOptimization: afterState }), action.deployment_id]
    );
  }

  // Restart the process for the affected system
  if (action.system_slug) {
    try {
      await restartProcess(`autopilate-${action.system_slug}`);
    } catch {
      console.warn(
        `[operators] Process restart failed for ${action.system_slug}`
      );
    }
  }
}

export { router as operatorsRouter };

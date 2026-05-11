// =============================================================================
// Schedules API Routes
// CRUD for cron schedules on deployed systems
// =============================================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { validateBody } from '../src/middleware/validation';
import { AppError } from '../src/middleware/error-handler';
import { pool } from '../db';
import {
  getScheduleStatus,
  refreshSchedule,
  removeSchedule,
} from '../services/cron-scheduler';

// -----------------------------------------------------------------------------
// Zod Schemas
// -----------------------------------------------------------------------------

const updateScheduleBodySchema = z.object({
  expression: z.string().min(1),
  timezone: z.string().min(1),
  enabled: z.boolean(),
});

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

const router = Router();

// GET /api/schedules — list all cron schedules with next run times
router.get('/', (_req: Request, res: Response) => {
  const schedules = getScheduleStatus();
  res.json({ schedules });
});

// PUT /api/systems/:slug/schedule — create or update cron schedule
router.put(
  '/:slug/schedule',
  validateBody(updateScheduleBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug } = req.params;
      const { expression, timezone, enabled } = req.body as z.infer<typeof updateScheduleBodySchema>;

      // Validate cron expression
      try {
        CronExpressionParser.parse(expression, { tz: timezone });
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        throw new AppError(400, `Invalid cron expression: ${msg}`, 'INVALID_CRON');
      }

      // Verify system exists and is deployed
      const { rows: systems } = await pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM deployments
         WHERE system_slug = $1 AND status != 'archived'`,
        [slug]
      );

      if (systems.length === 0) {
        throw new AppError(404, `System "${slug}" not found`, 'NOT_FOUND');
      }
      if (systems[0].status !== 'deployed') {
        throw new AppError(
          409,
          `System "${slug}" is not deployed (status: ${systems[0].status})`,
          'NOT_DEPLOYED'
        );
      }

      // Build trigger config
      const triggerConfig = {
        type: 'cron' as const,
        expression,
        timezone,
        enabled,
      };

      // Compute next run time
      let nextRunAt: string | null = null;
      if (enabled) {
        const interval = CronExpressionParser.parse(expression, {
          currentDate: new Date(),
          tz: timezone,
        });
        nextRunAt = interval.next().toDate().toISOString();
      }

      // Update deployment record
      await pool.query(
        `UPDATE deployments
         SET trigger_type = 'cron',
             trigger_config = $1::jsonb,
             cron_next_run_at = $2,
             updated_at = now()
         WHERE system_slug = $3 AND status != 'archived'`,
        [JSON.stringify(triggerConfig), nextRunAt, slug]
      );

      // Refresh in-memory schedule
      if (enabled) {
        await refreshSchedule(slug);
      } else {
        removeSchedule(slug);
      }

      res.json({
        slug,
        expression,
        timezone,
        enabled,
        nextRunAt,
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /api/systems/:slug/schedule — disable cron schedule
router.delete(
  '/:slug/schedule',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { slug } = req.params;

      // Update trigger_config to disabled
      const { rowCount } = await pool.query(
        `UPDATE deployments
         SET trigger_config = jsonb_set(
               COALESCE(trigger_config, '{}'::jsonb),
               '{enabled}',
               'false'::jsonb
             ),
             cron_next_run_at = NULL,
             updated_at = now()
         WHERE system_slug = $1 AND status != 'archived' AND trigger_type = 'cron'`,
        [slug]
      );

      if (rowCount === 0) {
        throw new AppError(404, `No cron schedule found for "${slug}"`, 'NOT_FOUND');
      }

      // Remove from in-memory schedule
      removeSchedule(slug);

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  }
);

export { router as schedulesRouter };

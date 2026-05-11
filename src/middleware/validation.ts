// =============================================================================
// Request Validation Middleware (Zod)
// =============================================================================

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

// -----------------------------------------------------------------------------
// Zod Schemas for API Endpoints
// -----------------------------------------------------------------------------

export const componentContentQuerySchema = z.object({
  path: z.string().min(1, 'path query parameter is required'),
});

export const inventorySearchQuerySchema = z.object({
  q: z.string().optional(),
  types: z.string().optional(),
  repos: z.string().optional(),
  categories: z.string().optional(),
  buckets: z.string().optional(),
  subcategories: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : undefined))
    .pipe(z.number().int().min(1).max(500).optional()),
  offset: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : undefined))
    .pipe(z.number().int().min(0).optional()),
});

export const capabilitiesQuerySchema = z.object({
  type: z.enum(['skill', 'hook', 'command']).optional(),
});

export const chatBodySchema = z.object({
  message: z.string().min(1, 'message is required'),
  sessionId: z.string().min(1, 'sessionId is required'),
});

export const configureWorkflowBodySchema = z.object({
  nodes: z.array(z.record(z.string(), z.unknown())),
  edges: z.array(z.record(z.string(), z.unknown())),
});

export const configureNodeBodySchema = z.object({
  node: z.record(z.string(), z.unknown()),
  workflowContext: z
    .object({
      nodeCount: z.number(),
      edgeCount: z.number(),
      connectedNodes: z.array(z.unknown()),
      workflowName: z.string(),
    })
    .optional(),
});

// -----------------------------------------------------------------------------
// Validation Middleware Factory
// -----------------------------------------------------------------------------

/**
 * Validate request query parameters against a Zod schema.
 */
export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({
        error: 'Validation error',
        details: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }
    req.query = result.data as typeof req.query;
    next();
  };
}

/**
 * Validate request body against a Zod schema.
 */
export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: 'Validation error',
        details: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

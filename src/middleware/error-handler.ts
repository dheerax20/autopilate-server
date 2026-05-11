// =============================================================================
// Centralized Error Handling Middleware
// =============================================================================

import { Request, Response, NextFunction } from 'express';
import { AutopilateError, isAutopilateError } from '../../lib/errors';

// -----------------------------------------------------------------------------
// Application Error Class
// -----------------------------------------------------------------------------

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// -----------------------------------------------------------------------------
// Error Handler Middleware
// -----------------------------------------------------------------------------

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Log the error (structured for production logging)
  console.error(`[Error] ${err.name}: ${err.message}`);

  if (isAutopilateError(err)) {
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
    });
    return;
  }

  // Don't leak internal error details to clients
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    status: 500,
  });
}

// -----------------------------------------------------------------------------
// 404 Handler
// -----------------------------------------------------------------------------

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}

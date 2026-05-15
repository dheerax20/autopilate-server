// =============================================================================
// API Key Authentication Middleware
// Validates X-API-Key header against AUTOPILATE_API_KEY env var
// =============================================================================

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { AuthenticationError } from '../../lib/errors';

const SKIP_PATHS = [
  '/health',
  '/inventory',
  '/inventory/search',
  '/inventory/bucket-counts',
  '/component-content',
  '/capabilities',
  '/configure-workflow',
  '/configure-node',
  '/metrics',
  // Auth login must be reachable without the admin X-API-Key — that's the
  // whole point. Logout/me/register still go through the api key check.
  '/auth/login',
];

// Paths that skip auth only for GET requests (browsing is public, mutations need auth)
const SKIP_GET_PREFIXES = [
  '/templates',
  '/schedules',
];

/**
 * Middleware that requires a valid API key in the X-API-Key header.
 * Skips /api/health for uptime monitoring.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function apiKeyAuth(req: Request, _res: Response, next: NextFunction): void {
  if (SKIP_PATHS.includes(req.path)) {
    return next();
  }

  // Allow unauthenticated GET requests on browsable paths (e.g. template marketplace)
  if (req.method === 'GET' && SKIP_GET_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + '/'))) {
    return next();
  }

  const expectedKey = process.env.AUTOPILATE_API_KEY;
  if (!expectedKey) {
    // If no API key is configured, skip auth (development mode)
    return next();
  }

  const providedKey = req.header('X-API-Key');
  if (!providedKey) {
    return next(new AuthenticationError('Missing X-API-Key header'));
  }

  // Timing-safe comparison to prevent timing attacks
  const expected = Buffer.from(expectedKey, 'utf-8');
  const provided = Buffer.from(providedKey, 'utf-8');

  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return next(new AuthenticationError('Invalid API key'));
  }

  next();
}

// =============================================================================
// User Bearer-Token Authentication Middleware
//
// Validates `Authorization: Bearer <token>` against tokens issued by
// services/auth-service.ts. Skips the login page and the login endpoint so
// unauthenticated users can actually sign in.
// =============================================================================

import { Request, Response, NextFunction } from 'express';
import { AuthenticationError } from '../../lib/errors';
import { verifyToken, TokenPayload } from '../../services/auth-service';

// Paths that must remain reachable without a bearer token. These are matched
// against `req.path` (which on `/api/*` routes is the suffix after `/api`).
const SKIP_API_PATHS = new Set<string>([
  '/auth/login',
  '/health',
]);

declare module 'express-serve-static-core' {
  interface Request {
    user?: TokenPayload;
    authToken?: string;
  }
}

/**
 * Express middleware that requires a valid bearer token for `/api/*` routes
 * (with a small whitelist for login + health). Mount this AFTER `apiKeyAuth`
 * so server-to-server callers carrying X-API-Key still go through, and user
 * sessions are layered on top.
 *
 * Mode of operation:
 *   - If `AUTOPILATE_REQUIRE_USER_AUTH` is unset or "false", the middleware
 *     only attaches `req.user` when a token is present — it never blocks.
 *     This keeps existing X-API-Key consumers working until the operator
 *     opts in to enforced user auth.
 *   - When set to "true", missing or invalid tokens get a 401.
 */
export function userAuth() {
  const enforce = process.env.AUTOPILATE_REQUIRE_USER_AUTH === 'true';

  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (SKIP_API_PATHS.has(req.path)) {
      return next();
    }

    const header = req.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;

    if (!token) {
      if (enforce) {
        return next(new AuthenticationError('Missing bearer token'));
      }
      return next();
    }

    try {
      const payload = await verifyToken(token);
      if (!payload) {
        if (enforce) {
          return next(new AuthenticationError('Invalid or expired token'));
        }
        return next();
      }
      req.user = payload;
      req.authToken = token;
      next();
    } catch (err) {
      next(err);
    }
  };
}

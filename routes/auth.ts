// =============================================================================
// Auth Routes — email/password login, logout, registration, current-user.
//
// /login is the only endpoint that doesn't require a bearer token. The
// `userAuth` middleware in src/middleware/auth.ts whitelists it.
// =============================================================================

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateBody } from '../src/middleware/validation';
import { AppError } from '../src/middleware/error-handler';
import {
  login,
  createUser,
  revokeToken,
  findUserById,
  AccountLockedError,
  InvalidCredentialsError,
  UserExistsError,
} from '../services/auth-service';

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address').max(320),
  password: z.string().min(1, 'Password is required').max(256),
});

const registerSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8, 'Password must be at least 8 characters').max(256),
  displayName: z.string().min(1).max(200).optional(),
});

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

const router = Router();

/**
 * POST /api/auth/login
 *
 * Body: { email, password }
 * Returns: { token, user, expiresInSec } on success.
 * On failure returns the typed AutopilateError JSON which includes a
 * human-readable message — including remaining attempts or lockout countdown.
 */
router.post(
  '/login',
  validateBody(loginSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body as { email: string; password: string };
      const result = await login(email, password);
      res.json(result);
    } catch (err) {
      if (err instanceof AccountLockedError) {
        res.setHeader('Retry-After', String(err.retryAfterSec));
      }
      // InvalidCredentialsError / AccountLockedError extend AutopilateError,
      // so the central error handler already serializes them with the right
      // status code and code/message.
      if (err instanceof InvalidCredentialsError || err instanceof AccountLockedError) {
        return next(err);
      }
      next(err);
    }
  }
);

/**
 * POST /api/auth/logout
 *
 * Revokes the bearer token. The userAuth middleware attaches the raw token
 * to req for us.
 */
router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = (req as Request & { authToken?: string }).authToken;
    if (token) {
      await revokeToken(token);
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me
 *
 * Returns the current user. Requires a valid bearer token.
 */
router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as Request & { user?: { userId: string } }).user?.userId;
    if (!userId) {
      throw new AppError(401, 'Authentication required', 'AUTH_REQUIRED');
    }
    const user = await findUserById(userId);
    if (!user) {
      throw new AppError(401, 'User no longer exists', 'AUTH_USER_NOT_FOUND');
    }
    res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      lastLoginAt: user.last_login_at,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/register
 *
 * Creates a user. This endpoint requires the X-API-Key admin key (enforced
 * by the apiKeyAuth middleware higher up the stack) — bootstrap the first
 * user with a curl call carrying the admin key.
 */
router.post(
  '/register',
  validateBody(registerSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await createUser(req.body);
      res.status(201).json(user);
    } catch (err) {
      if (err instanceof UserExistsError) {
        return next(err);
      }
      next(err);
    }
  }
);

export { router as authRouter };

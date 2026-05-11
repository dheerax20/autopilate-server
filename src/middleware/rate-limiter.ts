// =============================================================================
// Sliding Window Rate Limiter (in-memory)
// 100 requests per minute per IP using a Map of timestamp arrays
// =============================================================================

import { Request, Response, NextFunction } from 'express';
import { RateLimitError } from '../../lib/errors';

interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
}

const DEFAULT_OPTIONS: RateLimiterOptions = {
  windowMs: 60_000,
  maxRequests: 100,
};

// Periodic cleanup to prevent memory leaks (every 5 minutes)
const CLEANUP_INTERVAL = 5 * 60_000;

function startCleanup(requestLog: Map<string, number[]>, windowMs: number): void {
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, timestamps] of requestLog) {
      const filtered = timestamps.filter((t) => t > cutoff);
      if (filtered.length === 0) {
        requestLog.delete(ip);
      } else {
        requestLog.set(ip, filtered);
      }
    }
  }, CLEANUP_INTERVAL);
  timer.unref();
}

/**
 * Creates a sliding window rate limiter middleware.
 * Each instance maintains its own isolated request log so limiters
 * with different thresholds don't interfere with each other.
 */
export function slidingWindowRateLimiter(options: Partial<RateLimiterOptions> = {}) {
  const { windowMs, maxRequests } = { ...DEFAULT_OPTIONS, ...options };

  // Each limiter instance gets its own request log
  const requestLog = new Map<string, number[]>();
  startCleanup(requestLog, windowMs);

  return (req: Request, _res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    let timestamps = requestLog.get(ip);
    if (!timestamps) {
      timestamps = [];
      requestLog.set(ip, timestamps);
    }

    // Remove expired entries (sliding window)
    while (timestamps.length > 0 && timestamps[0] <= windowStart) {
      timestamps.shift();
    }

    if (timestamps.length >= maxRequests) {
      return next(new RateLimitError());
    }

    timestamps.push(now);
    next();
  };
}

// Export for testing — no longer a shared module-level map

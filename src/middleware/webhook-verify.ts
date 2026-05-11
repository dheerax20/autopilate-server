// =============================================================================
// Webhook Signature Verification Middleware
// Verifies X-Webhook-Signature header using HMAC-SHA256
// =============================================================================

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { WebhookSignatureError } from '../../lib/errors';

/**
 * Creates middleware that verifies HMAC-SHA256 webhook signatures.
 * The signature header format is: sha256=<hex digest>
 * The secret is read from the provided env var name.
 */
export function webhookVerify(secretEnvVar: string = 'WEBHOOK_SECRET') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const secret = process.env[secretEnvVar];
    if (!secret) {
      // If no webhook secret is configured, skip verification
      return next();
    }

    const signature = req.header('X-Webhook-Signature');
    if (!signature) {
      return next(new WebhookSignatureError('Missing X-Webhook-Signature header'));
    }

    // Expect format: sha256=<hex>
    const parts = signature.split('=');
    if (parts.length !== 2 || parts[0] !== 'sha256') {
      return next(new WebhookSignatureError('Invalid signature format, expected sha256=<hex>'));
    }

    const providedDigest = parts[1];
    const body = JSON.stringify(req.body);
    const expectedDigest = crypto
      .createHmac('sha256', secret)
      .update(body, 'utf-8')
      .digest('hex');

    // Timing-safe comparison
    const expected = Buffer.from(expectedDigest, 'hex');
    const provided = Buffer.from(providedDigest, 'hex');

    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
      return next(new WebhookSignatureError('Signature mismatch'));
    }

    next();
  };
}

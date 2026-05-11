// =============================================================================
// Typed Error System for AUTOPILATE
// Base class + domain-specific subclasses with error codes and HTTP status mapping
// =============================================================================

export class AutopilateError extends Error {
  public code: string;
  public statusCode: number;
  public cause?: unknown;

  constructor(code: string, message: string, statusCode: number = 500, cause?: unknown) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.cause = cause;
    this.name = 'AutopilateError';
  }

  toJSON(): { error: string; code: string; status: number } {
    return { error: this.message, code: this.code, status: this.statusCode };
  }
}

// --- Deployment Errors (deploy-bridge, registry, PM2) ---

export class DeploymentError extends AutopilateError {
  public readonly step?: string;

  constructor(code: string, message: string, step?: string, cause?: unknown, statusCode = 500) {
    super(`DEPLOYMENT_${code}`, message, statusCode, cause);
    this.step = step;
    this.name = 'DeploymentError';
  }
}

export class SystemNotFoundError extends DeploymentError {
  constructor(slug: string) {
    super('NOT_FOUND', `System not found: ${slug}`, 'registry', undefined, 404);
    this.name = 'SystemNotFoundError';
  }
}

export class PM2ProcessError extends DeploymentError {
  constructor(message: string, processName?: string, cause?: unknown) {
    super('PM2_FAILURE', message, processName ?? 'pm2', cause);
    this.name = 'PM2ProcessError';
  }
}

// --- Export Errors (canvas export, bundle generation) ---

export class ExportError extends AutopilateError {
  constructor(code: string, message: string, cause?: unknown) {
    super(`EXPORT_${code}`, message, 400, cause);
    this.name = 'ExportError';
  }
}

// --- Router Errors (message routing, system matching) ---

export class RouterError extends AutopilateError {
  constructor(code: string, message: string, statusCode = 500, cause?: unknown) {
    super(`ROUTER_${code}`, message, statusCode, cause);
    this.name = 'RouterError';
  }
}

// --- Operator Errors (system monitor, QA remediation, optimization) ---

export class OperatorError extends AutopilateError {
  constructor(
    code: string,
    message: string,
    public readonly step?: string,
    cause?: unknown
  ) {
    super(`OPERATOR_${code}`, message, 500, cause);
    this.name = 'OperatorError';
  }
}

export class QaRemediationError extends OperatorError {
  constructor(message: string, step: string, cause?: unknown) {
    super('QA_REMEDIATION', message, step, cause);
  }
}

// --- Database Errors (connection, query failures) ---

export class DatabaseError extends AutopilateError {
  constructor(code: string, message: string, cause?: unknown) {
    super(`DATABASE_${code}`, message, 503, cause);
    this.name = 'DatabaseError';
  }
}

// --- Trigger Errors ---

export class TriggerConfigError extends DeploymentError {
  constructor(message: string, triggerType?: string) {
    super('TRIGGER_INVALID', message, triggerType ?? 'trigger');
  }
}

// --- Security Errors (auth, rate limiting, webhook verification) ---

export class AuthenticationError extends AutopilateError {
  constructor(message: string = 'Authentication required') {
    super('AUTH_FAILED', message, 401);
    this.name = 'AuthenticationError';
  }
}

export class RateLimitError extends AutopilateError {
  constructor(message: string = 'Too many requests, please try again later') {
    super('RATE_LIMITED', message, 429);
    this.name = 'RateLimitError';
  }
}

export class WebhookSignatureError extends AutopilateError {
  constructor(message: string = 'Invalid webhook signature') {
    super('WEBHOOK_SIGNATURE_INVALID', message, 401);
    this.name = 'WebhookSignatureError';
  }
}

// --- Utility: check if an error is an AutopilateError ---

export function isAutopilateError(err: unknown): err is AutopilateError {
  return err instanceof AutopilateError;
}

// --- Utility: wrap unknown errors as AutopilateError ---

export function wrapError(err: unknown, fallbackCode: string, fallbackMessage: string): AutopilateError {
  if (err instanceof AutopilateError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AutopilateError(fallbackCode, `${fallbackMessage}: ${message}`, 500, err);
}

import { describe, it, expect, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { AppError, errorHandler, notFoundHandler } from './error-handler';
import { DeploymentError, SystemNotFoundError } from '../../lib/errors';

function mockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe('AppError', () => {
  it('stores statusCode and message', () => {
    const err = new AppError(404, 'Not found', 'NOT_FOUND');
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe('Not found');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.name).toBe('AppError');
  });
});

describe('errorHandler', () => {
  it('returns AppError status and message', () => {
    const err = new AppError(422, 'Validation failed', 'VALIDATION');
    const res = mockRes();

    errorHandler(err, {} as Request, res, (() => {}) as NextFunction);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Validation failed',
      code: 'VALIDATION',
    });
  });

  it('returns generic 500 for unknown errors', () => {
    const err = new Error('something broke');
    const res = mockRes();

    errorHandler(err, {} as Request, res, (() => {}) as NextFunction);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      status: 500,
    });
  });

  it('returns AutopilateError status and formatted JSON', () => {
    const err = new DeploymentError('PM2_NO_CONFIG', 'No PM2 config found', 'pm2-start');
    const res = mockRes();

    errorHandler(err, {} as Request, res, (() => {}) as NextFunction);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'No PM2 config found',
      code: 'DEPLOYMENT_PM2_NO_CONFIG',
      status: 500,
    });
  });

  it('returns 404 for SystemNotFoundError', () => {
    const err = new SystemNotFoundError('my-system');
    const res = mockRes();

    errorHandler(err, {} as Request, res, (() => {}) as NextFunction);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: 'System not found: my-system',
      code: 'DEPLOYMENT_NOT_FOUND',
      status: 404,
    });
  });

  it('does not leak internal error details', () => {
    const err = new Error('database connection failed at host db.internal:5432');
    const res = mockRes();

    errorHandler(err, {} as Request, res, (() => {}) as NextFunction);

    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonCall.error).not.toContain('database');
    expect(jsonCall.error).not.toContain('db.internal');
  });
});

describe('notFoundHandler', () => {
  it('returns 404', () => {
    const res = mockRes();
    notFoundHandler({} as Request, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not found' });
  });
});

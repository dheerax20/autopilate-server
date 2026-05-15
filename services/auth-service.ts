// =============================================================================
// Authentication Service — email/password login with Redis-backed lockout
//
// - Passwords hashed with scrypt (Node built-in, no extra deps).
// - Failed login attempts are counted in Redis under `auth:fails:<email>`
//   with a 10-minute sliding TTL. Once the counter reaches MAX_ATTEMPTS the
//   account is locked out until the key expires.
// - Successful logins clear the counter and issue an opaque bearer token
//   stored in Redis under `auth:token:<token>` with a TTL of TOKEN_TTL_SEC.
// =============================================================================

import crypto from 'crypto';
import { promisify } from 'util';
import { pool } from '../db';
import { getRedisClient } from '../lib/redis';
import { AutopilateError } from '../lib/errors';

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: string,
  keylen: number
) => Promise<Buffer>;

// -----------------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------------

export const MAX_ATTEMPTS = 5;
export const LOCKOUT_TTL_SEC = 10 * 60; // 10 minutes
export const TOKEN_TTL_SEC = 24 * 60 * 60; // 24 hours

const SCRYPT_KEYLEN = 64;
const TOKEN_BYTES = 32;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  is_active: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface LoginResult {
  user: PublicUser;
  token: string;
  expiresInSec: number;
}

// -----------------------------------------------------------------------------
// Typed errors — caught in the route layer to map to HTTP responses
// -----------------------------------------------------------------------------

export class InvalidCredentialsError extends AutopilateError {
  public readonly attemptsRemaining: number;

  constructor(attemptsRemaining: number) {
    super(
      'AUTH_INVALID_CREDENTIALS',
      attemptsRemaining > 0
        ? `Invalid email or password. ${attemptsRemaining} attempt${
            attemptsRemaining === 1 ? '' : 's'
          } remaining before lockout.`
        : 'Invalid email or password.',
      401
    );
    this.attemptsRemaining = attemptsRemaining;
    this.name = 'InvalidCredentialsError';
  }
}

export class AccountLockedError extends AutopilateError {
  public readonly retryAfterSec: number;

  constructor(retryAfterSec: number) {
    const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
    super(
      'AUTH_ACCOUNT_LOCKED',
      `Too many failed login attempts. Account locked. Try again in ${minutes} minute${
        minutes === 1 ? '' : 's'
      }.`,
      423
    );
    this.retryAfterSec = retryAfterSec;
    this.name = 'AccountLockedError';
  }
}

export class UserExistsError extends AutopilateError {
  constructor(email: string) {
    super('AUTH_USER_EXISTS', `User already exists: ${email}`, 409);
    this.name = 'UserExistsError';
  }
}

// -----------------------------------------------------------------------------
// Password hashing (scrypt)
// -----------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  let derived: Buffer;
  try {
    derived = await scrypt(password, salt, expected.length);
  } catch {
    return false;
  }
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(expected, derived);
}

// -----------------------------------------------------------------------------
// Redis keys
// -----------------------------------------------------------------------------

const failsKey = (email: string): string => `auth:fails:${email}`;
const tokenKey = (token: string): string => `auth:token:${token}`;

// -----------------------------------------------------------------------------
// User CRUD
// -----------------------------------------------------------------------------

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toPublic(row: UserRow): PublicUser {
  return { id: row.id, email: row.email, displayName: row.display_name };
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT * FROM users WHERE email = $1 LIMIT 1`,
    [normalizeEmail(email)]
  );
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT * FROM users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function createUser(input: {
  email: string;
  password: string;
  displayName?: string;
}): Promise<PublicUser> {
  const email = normalizeEmail(input.email);
  const existing = await findUserByEmail(email);
  if (existing) {
    throw new UserExistsError(email);
  }
  const passwordHash = await hashPassword(input.password);
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [email, passwordHash, input.displayName ?? null]
  );
  return toPublic(rows[0]);
}

// -----------------------------------------------------------------------------
// Lockout helpers
// -----------------------------------------------------------------------------

interface LockoutState {
  count: number;
  ttlSec: number;
}

async function getLockoutState(email: string): Promise<LockoutState> {
  const redis = getRedisClient();
  const key = failsKey(email);
  const [countRaw, ttl] = await Promise.all([redis.get(key), redis.ttl(key)]);
  const count = countRaw ? parseInt(countRaw, 10) : 0;
  return { count, ttlSec: ttl > 0 ? ttl : 0 };
}

async function recordFailure(email: string): Promise<number> {
  const redis = getRedisClient();
  const key = failsKey(email);
  const newCount = await redis.incr(key);
  // Sliding window — every failure refreshes the 10-minute clock.
  await redis.expire(key, LOCKOUT_TTL_SEC);
  return newCount;
}

async function clearFailures(email: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(failsKey(email));
}

// -----------------------------------------------------------------------------
// Login
// -----------------------------------------------------------------------------

export async function login(emailRaw: string, password: string): Promise<LoginResult> {
  const email = normalizeEmail(emailRaw);

  // 1. Pre-check lockout BEFORE doing any DB work or password compare.
  const pre = await getLockoutState(email);
  if (pre.count >= MAX_ATTEMPTS) {
    throw new AccountLockedError(pre.ttlSec || LOCKOUT_TTL_SEC);
  }

  const user = await findUserByEmail(email);
  // Compare against a dummy hash if user is missing so the response time
  // doesn't leak account existence.
  const stored = user?.password_hash
    ?? 'scrypt$0000000000000000$0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
  const passwordOk = await verifyPassword(password, stored);

  if (!user || !user.is_active || !passwordOk) {
    const newCount = await recordFailure(email);
    if (newCount >= MAX_ATTEMPTS) {
      // Just hit the threshold — surface the lockout message immediately.
      throw new AccountLockedError(LOCKOUT_TTL_SEC);
    }
    throw new InvalidCredentialsError(Math.max(0, MAX_ATTEMPTS - newCount));
  }

  // Success — clear the failure counter and issue a token.
  await clearFailures(email);

  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const redis = getRedisClient();
  await redis.set(
    tokenKey(token),
    JSON.stringify({ userId: user.id, email: user.email }),
    'EX',
    TOKEN_TTL_SEC
  );

  await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);

  return {
    user: toPublic(user),
    token,
    expiresInSec: TOKEN_TTL_SEC,
  };
}

// -----------------------------------------------------------------------------
// Token verification + revocation
// -----------------------------------------------------------------------------

export interface TokenPayload {
  userId: string;
  email: string;
}

export async function verifyToken(token: string): Promise<TokenPayload | null> {
  if (!token) return null;
  const redis = getRedisClient();
  const raw = await redis.get(tokenKey(token));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TokenPayload;
    if (typeof parsed.userId !== 'string' || typeof parsed.email !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function revokeToken(token: string): Promise<void> {
  if (!token) return;
  const redis = getRedisClient();
  await redis.del(tokenKey(token));
}

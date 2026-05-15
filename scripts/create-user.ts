// =============================================================================
// CLI helper to bootstrap the first user.
//
// Usage:
//   ts-node scripts/create-user.ts <email> <password> [displayName]
// =============================================================================

import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '..', '.env'), override: true });

import { runMigrations, pool } from '../db';
import { createUser } from '../services/auth-service';
import { shutdownRedisPublisher } from '../lib/redis';

async function main(): Promise<void> {
  const [, , email, password, displayName] = process.argv;

  if (!email || !password) {
    console.error('Usage: ts-node scripts/create-user.ts <email> <password> [displayName]');
    process.exit(2);
  }
  if (password.length < 8) {
    console.error('Error: password must be at least 8 characters.');
    process.exit(2);
  }

  await runMigrations();
  const user = await createUser({ email, password, displayName });
  console.log(`Created user ${user.email} (${user.id})`);
}

main()
  .catch((err) => {
    console.error('Failed to create user:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
    await shutdownRedisPublisher().catch(() => {});
  });

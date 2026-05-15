import { Client } from 'pg';

/**
 * Users table — backs the email+password auth layer.
 *
 * Password is stored as a scrypt-derived hash: `scrypt$<salt_hex>$<hash_hex>`.
 * Email is normalized to lowercase on write (enforced in the auth service)
 * and indexed UNIQUE so login lookups are O(1).
 */
export async function up(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email           varchar(320) UNIQUE NOT NULL,
      password_hash   text NOT NULL,
      display_name    varchar(200),
      is_active       boolean NOT NULL DEFAULT true,
      last_login_at   timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
  `);
}

export async function down(client: Client): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS users;`);
}

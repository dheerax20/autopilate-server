import { Pool, Client } from 'pg';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

// Load .env when running db.ts directly (migrations)
dotenv.config({ path: path.resolve(__dirname, '.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export { pool };

interface Migration {
  up: (client: Client) => Promise<void>;
  down: (client: Client) => Promise<void>;
}

export async function runMigrations(): Promise<void> {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  await client.connect();

  try {
    // Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id serial PRIMARY KEY,
        name varchar(255) UNIQUE NOT NULL,
        applied_at timestamptz DEFAULT now()
      );
    `);

    // Read migration files sorted alphabetically (timestamp prefix ensures order)
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
      .sort();

    for (const file of files) {
      const name = path.basename(file, path.extname(file));

      // Skip already-applied migrations
      const { rows } = await client.query(
        'SELECT 1 FROM _migrations WHERE name = $1',
        [name]
      );

      if (rows.length > 0) {
        console.log(`Skipping already applied: ${name}`);
        continue;
      }

      console.log(`Applying migration: ${name}`);
      const migration: Migration = require(path.join(migrationsDir, file));

      await client.query('BEGIN');
      try {
        await migration.up(client);
        await client.query(
          'INSERT INTO _migrations (name) VALUES ($1)',
          [name]
        );
        await client.query('COMMIT');
        console.log(`Applied: ${name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log('All migrations applied.');
  } finally {
    await client.end();
  }
}

// Run directly via: ts-node db.ts migrate
if (require.main === module && process.argv[2] === 'migrate') {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

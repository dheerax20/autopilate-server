import { Client } from 'pg';

export async function up(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS execution_metrics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      system_slug VARCHAR(255) NOT NULL,
      execution_id UUID REFERENCES execution_logs(id),
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      duration_seconds FLOAT,
      status VARCHAR(20) NOT NULL CHECK (status IN ('running', 'success', 'failed', 'timeout')),
      phases_total INT NOT NULL DEFAULT 0,
      phases_completed INT NOT NULL DEFAULT 0,
      cost_usd FLOAT DEFAULT 0,
      error_message TEXT,
      triggered_by VARCHAR(50),
      triggered_channel VARCHAR(50),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_metrics_execution_id
      ON execution_metrics(execution_id);

    CREATE INDEX IF NOT EXISTS idx_metrics_slug_time
      ON execution_metrics(system_slug, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_metrics_status
      ON execution_metrics(status);
  `);
}

export async function down(client: Client): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS execution_metrics;
  `);
}

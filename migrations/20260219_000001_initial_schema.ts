import { Client } from 'pg';

export async function up(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE deployments (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      system_name     varchar(255) NOT NULL,
      system_slug     varchar(128) UNIQUE NOT NULL,
      manifest_json   jsonb,
      canvas_json     jsonb,
      openclaw_config jsonb,
      trigger_type    varchar(50),
      trigger_config  jsonb,
      pm2_process_name varchar(128),
      status          varchar(20) DEFAULT 'deployed',
      secrets_encrypted bytea,
      deployed_at     timestamptz DEFAULT now(),
      created_at      timestamptz DEFAULT now(),
      updated_at      timestamptz DEFAULT now()
    );

    CREATE TABLE execution_logs (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deployment_id     uuid NOT NULL REFERENCES deployments(id),
      triggered_by      varchar(50),
      trigger_input     jsonb,
      status            varchar(20),
      phases_completed  int,
      phases_total      int,
      output_url        text,
      output_type       varchar(50),
      cost_usd          decimal(10,4),
      duration_seconds  int,
      qa_scores         jsonb,
      error_message     text,
      started_at        timestamptz,
      completed_at      timestamptz
    );

    CREATE INDEX idx_execution_logs_deployment_id
      ON execution_logs (deployment_id);

    CREATE TABLE operator_actions (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deployment_id   uuid REFERENCES deployments(id),
      operator_type   varchar(30),
      action_type     varchar(50),
      description     text,
      before_state    jsonb,
      after_state     jsonb,
      auto_applied    boolean DEFAULT false,
      approved        boolean,
      created_at      timestamptz DEFAULT now()
    );

    CREATE INDEX idx_operator_actions_deployment_id
      ON operator_actions (deployment_id);
  `);
}

export async function down(client: Client): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS operator_actions;
    DROP TABLE IF EXISTS execution_logs;
    DROP TABLE IF EXISTS deployments;
  `);
}

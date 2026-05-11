import { Client } from 'pg';

export async function up(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS system_templates (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name              VARCHAR(255) NOT NULL,
      slug              VARCHAR(128) UNIQUE NOT NULL,
      description       TEXT NOT NULL,
      long_description  TEXT,
      category          VARCHAR(50) NOT NULL,
      tags              TEXT[] DEFAULT '{}',
      version           VARCHAR(20) NOT NULL DEFAULT '1.0.0',
      author            VARCHAR(255) DEFAULT 'AUTOPILATE',

      -- System content (the actual template data)
      manifest_json     JSONB NOT NULL,
      canvas_json       JSONB NOT NULL,
      agent_configs     JSONB DEFAULT '{}',
      mcp_configs       JSONB DEFAULT '[]',
      env_example       JSONB DEFAULT '{}',

      -- Metadata
      output_type       VARCHAR(50),
      trigger_pattern   VARCHAR(50),
      estimated_cost_usd DECIMAL(10,4) DEFAULT 0,
      node_count        INT DEFAULT 0,
      edge_count        INT DEFAULT 0,

      -- Marketplace stats
      install_count     INT DEFAULT 0,
      rating_avg        DECIMAL(3,2) DEFAULT 0,
      rating_count      INT DEFAULT 0,
      featured          BOOLEAN DEFAULT false,

      -- Status
      status            VARCHAR(20) DEFAULT 'published'
                        CHECK (status IN ('draft', 'published', 'archived')),
      published_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_templates_category
      ON system_templates(category);

    CREATE INDEX IF NOT EXISTS idx_templates_tags
      ON system_templates USING GIN(tags);

    CREATE INDEX IF NOT EXISTS idx_templates_status
      ON system_templates(status);

    CREATE INDEX IF NOT EXISTS idx_templates_featured
      ON system_templates(featured) WHERE featured = true;

    CREATE INDEX IF NOT EXISTS idx_templates_installs
      ON system_templates(install_count DESC);
  `);
}

export async function down(client: Client): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS system_templates;
  `);
}

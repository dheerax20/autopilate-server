// =============================================================================
// Template Marketplace Service
// =============================================================================

import { pool } from '../db';
import { registerSystem, getSystem } from './registry';
import { SystemBundle, SystemCategory } from '../types/registry';
import { AutopilateError } from '../lib/errors';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type TemplateStatus = 'draft' | 'published' | 'archived';

export interface TemplateRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  longDescription: string | null;
  category: string;
  tags: string[];
  version: string;
  author: string;
  manifestJson: unknown;
  canvasJson: unknown;
  agentConfigs: unknown;
  mcpConfigs: unknown;
  envExample: Record<string, string>;
  outputType: string | null;
  triggerPattern: string | null;
  estimatedCostUsd: number;
  nodeCount: number;
  edgeCount: number;
  installCount: number;
  ratingAvg: number;
  ratingCount: number;
  featured: boolean;
  status: TemplateStatus;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// -----------------------------------------------------------------------------
// Row → Record mapper
// -----------------------------------------------------------------------------

interface TemplateRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  long_description: string | null;
  category: string;
  tags: string[];
  version: string;
  author: string;
  manifest_json: unknown;
  canvas_json: unknown;
  agent_configs: unknown;
  mcp_configs: unknown;
  env_example: Record<string, string>;
  output_type: string | null;
  trigger_pattern: string | null;
  estimated_cost_usd: string;
  node_count: number;
  edge_count: number;
  install_count: number;
  rating_avg: string;
  rating_count: number;
  featured: boolean;
  status: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: TemplateRow): TemplateRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    longDescription: row.long_description,
    category: row.category,
    tags: row.tags ?? [],
    version: row.version,
    author: row.author,
    manifestJson: row.manifest_json,
    canvasJson: row.canvas_json,
    agentConfigs: row.agent_configs,
    mcpConfigs: row.mcp_configs,
    envExample: row.env_example ?? {},
    outputType: row.output_type,
    triggerPattern: row.trigger_pattern,
    estimatedCostUsd: parseFloat(row.estimated_cost_usd) || 0,
    nodeCount: row.node_count,
    edgeCount: row.edge_count,
    installCount: row.install_count,
    ratingAvg: parseFloat(row.rating_avg) || 0,
    ratingCount: row.rating_count,
    featured: row.featured,
    status: row.status as TemplateStatus,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------

export class TemplateNotFoundError extends AutopilateError {
  constructor(slug: string) {
    super('TEMPLATE_NOT_FOUND', `Template not found: ${slug}`, 404);
    this.name = 'TemplateNotFoundError';
  }
}

// -----------------------------------------------------------------------------
// List published templates with filtering and sorting
// -----------------------------------------------------------------------------

export async function listTemplates(opts: {
  category?: string;
  tags?: string[];
  search?: string;
  sortBy?: 'popular' | 'newest' | 'rating';
  limit?: number;
  offset?: number;
}): Promise<{ templates: TemplateRecord[]; total: number }> {
  const conditions: string[] = [`status = 'published'`];
  const params: unknown[] = [];

  if (opts.category) {
    params.push(opts.category);
    conditions.push(`category = $${params.length}`);
  }

  if (opts.tags && opts.tags.length > 0) {
    params.push(opts.tags);
    conditions.push(`tags @> $${params.length}::text[]`);
  }

  if (opts.search) {
    params.push(`%${opts.search}%`);
    const idx = params.length;
    conditions.push(`(name ILIKE $${idx} OR description ILIKE $${idx})`);
  }

  const where = conditions.join(' AND ');

  // Count total matching rows
  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM system_templates WHERE ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  // Determine sort order
  let orderBy: string;
  switch (opts.sortBy) {
    case 'rating':
      orderBy = 'rating_avg DESC, install_count DESC';
      break;
    case 'newest':
      orderBy = 'published_at DESC NULLS LAST';
      break;
    case 'popular':
    default:
      orderBy = 'install_count DESC, rating_avg DESC';
      break;
  }

  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  params.push(limit, offset);

  const { rows } = await pool.query<TemplateRow>(
    `SELECT * FROM system_templates
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { templates: rows.map(rowToRecord), total };
}

// -----------------------------------------------------------------------------
// Get single template by slug
// -----------------------------------------------------------------------------

export async function getTemplate(slug: string): Promise<TemplateRecord | null> {
  const { rows } = await pool.query<TemplateRow>(
    `SELECT * FROM system_templates WHERE slug = $1 AND status = 'published'`,
    [slug]
  );

  if (rows.length === 0) return null;
  return rowToRecord(rows[0]);
}

// -----------------------------------------------------------------------------
// Publish a template (upsert by slug)
// -----------------------------------------------------------------------------

export async function publishTemplate(data: {
  name: string;
  slug: string;
  description: string;
  longDescription?: string;
  category: string;
  tags?: string[];
  version?: string;
  author?: string;
  manifestJson: unknown;
  canvasJson: unknown;
  agentConfigs?: unknown;
  mcpConfigs?: unknown;
  envExample?: Record<string, string>;
  outputType?: string;
  triggerPattern?: string;
  estimatedCostUsd?: number;
  nodeCount?: number;
  edgeCount?: number;
}): Promise<TemplateRecord> {
  const { rows } = await pool.query<TemplateRow>(
    `INSERT INTO system_templates (
       name, slug, description, long_description, category, tags, version,
       author, manifest_json, canvas_json, agent_configs, mcp_configs,
       env_example, output_type, trigger_pattern, estimated_cost_usd,
       node_count, edge_count, status, published_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6::text[], $7, $8,
       $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
       $13::jsonb, $14, $15, $16, $17, $18, 'published', NOW()
     )
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       long_description = EXCLUDED.long_description,
       category = EXCLUDED.category,
       tags = EXCLUDED.tags,
       version = EXCLUDED.version,
       author = EXCLUDED.author,
       manifest_json = EXCLUDED.manifest_json,
       canvas_json = EXCLUDED.canvas_json,
       agent_configs = EXCLUDED.agent_configs,
       mcp_configs = EXCLUDED.mcp_configs,
       env_example = EXCLUDED.env_example,
       output_type = EXCLUDED.output_type,
       trigger_pattern = EXCLUDED.trigger_pattern,
       estimated_cost_usd = EXCLUDED.estimated_cost_usd,
       node_count = EXCLUDED.node_count,
       edge_count = EXCLUDED.edge_count,
       status = 'published',
       published_at = NOW(),
       updated_at = NOW()
     RETURNING *`,
    [
      data.name,
      data.slug,
      data.description,
      data.longDescription ?? null,
      data.category,
      data.tags ?? [],
      data.version ?? '1.0.0',
      data.author ?? 'AUTOPILATE',
      JSON.stringify(data.manifestJson),
      JSON.stringify(data.canvasJson),
      JSON.stringify(data.agentConfigs ?? {}),
      JSON.stringify(data.mcpConfigs ?? []),
      JSON.stringify(data.envExample ?? {}),
      data.outputType ?? null,
      data.triggerPattern ?? null,
      data.estimatedCostUsd ?? 0,
      data.nodeCount ?? 0,
      data.edgeCount ?? 0,
    ]
  );

  return rowToRecord(rows[0]);
}

// -----------------------------------------------------------------------------
// Install a template → create a new deployment
// -----------------------------------------------------------------------------

export async function installTemplate(templateSlug: string): Promise<{
  deploymentSlug: string;
  systemName: string;
}> {
  // 1. Fetch template
  const { rows } = await pool.query<TemplateRow>(
    `SELECT * FROM system_templates WHERE slug = $1 AND status = 'published'`,
    [templateSlug]
  );

  if (rows.length === 0) {
    throw new TemplateNotFoundError(templateSlug);
  }

  const template = rowToRecord(rows[0]);
  const manifest = template.manifestJson as Record<string, unknown>;

  // 2. Increment install_count
  await pool.query(
    `UPDATE system_templates SET install_count = install_count + 1, updated_at = NOW()
     WHERE slug = $1`,
    [templateSlug]
  );

  // 3. Find a unique deployment slug (handle collision)
  let deploySlug = template.slug;
  let suffix = 1;
  while (await getSystem(deploySlug)) {
    deploySlug = `${template.slug}-${suffix}`;
    suffix++;
  }

  // 4. Build a SystemBundle from template data
  const bundle: SystemBundle = {
    manifest: {
      name: template.name,
      slug: deploySlug,
      description: template.description,
      version: template.version,
      category: (manifest.category ?? template.category) as SystemCategory,
      requiredInputs: (manifest.requiredInputs as SystemBundle['manifest']['requiredInputs']) ?? [],
      outputType: (manifest.outputType as SystemBundle['manifest']['outputType']) ?? 'data',
      estimatedCostUsd: template.estimatedCostUsd,
      triggerPattern: (manifest.triggerPattern as SystemBundle['manifest']['triggerPattern']) ?? 'webhook',
      nodeCount: template.nodeCount,
      edgeCount: template.edgeCount,
    },
    canvasJson: template.canvasJson,
    agentConfigs: (template.agentConfigs as Record<string, never>) ?? {},
    mcpConfigs: (template.mcpConfigs as SystemBundle['mcpConfigs']) ?? [],
    pm2Ecosystem: { apps: [] },
    envExample: template.envExample,
    createdAt: new Date().toISOString(),
  };

  // 5. Register as a deployment
  const deployment = await registerSystem(bundle);

  return {
    deploymentSlug: deployment.systemSlug,
    systemName: deployment.systemName,
  };
}

// -----------------------------------------------------------------------------
// Publish from an existing deployment
// -----------------------------------------------------------------------------

export async function publishFromDeployment(
  deploymentSlug: string,
  extra: {
    longDescription?: string;
    tags?: string[];
  }
): Promise<TemplateRecord> {
  const deployment = await getSystem(deploymentSlug);
  if (!deployment) {
    throw new AutopilateError(
      'DEPLOYMENT_NOT_FOUND',
      `Deployment not found: ${deploymentSlug}`,
      404
    );
  }

  const manifest = deployment.manifestJson;

  return publishTemplate({
    name: manifest.name,
    slug: manifest.slug,
    description: manifest.description,
    longDescription: extra.longDescription,
    category: manifest.category,
    tags: extra.tags,
    version: manifest.version,
    manifestJson: manifest,
    canvasJson: deployment.canvasJson,
    outputType: manifest.outputType,
    triggerPattern: manifest.triggerPattern,
    estimatedCostUsd: manifest.estimatedCostUsd,
    nodeCount: manifest.nodeCount,
    edgeCount: manifest.edgeCount,
  });
}

// -----------------------------------------------------------------------------
// Archive a template (soft delete)
// -----------------------------------------------------------------------------

export async function archiveTemplate(slug: string): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE system_templates SET status = 'archived', updated_at = NOW()
     WHERE slug = $1 AND status != 'archived'`,
    [slug]
  );

  if (rowCount === 0) {
    throw new TemplateNotFoundError(slug);
  }
}

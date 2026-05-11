// =============================================================================
// Deployment Registry Service
// =============================================================================

import { pool } from '../db';
import {
  SystemBundle,
  DeploymentRecord,
  DeploymentStatus,
} from '../types/registry';
import { encrypt, decrypt } from '../lib/crypto';

// -----------------------------------------------------------------------------
// Row → DeploymentRecord mapper
// -----------------------------------------------------------------------------

interface DeploymentRow {
  id: string;
  system_name: string;
  system_slug: string;
  manifest_json: unknown;
  canvas_json: unknown;
  openclaw_config: unknown;
  trigger_type: string;
  trigger_config: unknown;
  pm2_process_name: string;
  secrets_encrypted: string | null;
  status: string;
  domain: string | null;
  tags: string[] | null;
  deployed_at: string;
  created_at: string;
  updated_at: string;
}

function decryptSecrets(encrypted: string | null): Record<string, string> | null {
  if (!encrypted) return null;
  if (!process.env.ENCRYPTION_KEY) return null;
  try {
    return JSON.parse(decrypt(encrypted)) as Record<string, string>;
  } catch {
    console.warn('[registry] Failed to decrypt secrets — returning null');
    return null;
  }
}

function encryptSecrets(secrets: Record<string, string>): string | null {
  if (Object.keys(secrets).length === 0) return null;
  // ENCRYPTION_KEY is validated at server startup — this is a defense-in-depth check
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error(
      'ENCRYPTION_KEY is required for secret encryption. '
      + 'Server should not start without it — check startup validation.'
    );
  }
  return encrypt(JSON.stringify(secrets));
}

function rowToRecord(row: DeploymentRow): DeploymentRecord {
  return {
    id: row.id,
    systemName: row.system_name,
    systemSlug: row.system_slug,
    manifestJson: row.manifest_json as DeploymentRecord['manifestJson'],
    canvasJson: row.canvas_json,
    openclawConfig: row.openclaw_config,
    triggerType: row.trigger_type as DeploymentRecord['triggerType'],
    triggerConfig: row.trigger_config,
    pm2ProcessName: row.pm2_process_name,
    secretsDecrypted: decryptSecrets(row.secrets_encrypted),
    status: row.status as DeploymentStatus,
    domain: row.domain,
    tags: row.tags ?? [],
    deployedAt: row.deployed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// -----------------------------------------------------------------------------
// Registry Functions
// -----------------------------------------------------------------------------

export async function registerSystem(
  bundle: SystemBundle
): Promise<DeploymentRecord> {
  const { manifest, canvasJson } = bundle;
  const pm2ProcessName = `autopilate-${manifest.slug}`;

  const encryptedSecrets = encryptSecrets(bundle.envExample);

  const { rows } = await pool.query<DeploymentRow>(
    `INSERT INTO deployments (
       system_name,
       system_slug,
       manifest_json,
       canvas_json,
       trigger_type,
       trigger_config,
       pm2_process_name,
       secrets_encrypted,
       status,
       deployed_at
     ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7, $8, $9, now())
     RETURNING *`,
    [
      manifest.name,
      manifest.slug,
      JSON.stringify(manifest),
      JSON.stringify(canvasJson),
      manifest.triggerPattern,
      JSON.stringify({}),
      pm2ProcessName,
      encryptedSecrets,
      'deployed',
    ]
  );

  return rowToRecord(rows[0]);
}

export async function getSystem(
  slug: string
): Promise<DeploymentRecord | null> {
  const { rows } = await pool.query<DeploymentRow>(
    `SELECT * FROM deployments WHERE system_slug = $1 AND status != 'archived'`,
    [slug]
  );

  if (rows.length === 0) return null;
  return rowToRecord(rows[0]);
}

/**
 * List deployed systems. When `domain` is provided, only systems in that
 * domain are returned (plus systems with domain=NULL which are global).
 * When omitted, all non-archived systems are returned regardless of domain.
 */
export async function listSystems(domain?: string): Promise<DeploymentRecord[]> {
  if (domain) {
    const { rows } = await pool.query<DeploymentRow>(
      `SELECT * FROM deployments
       WHERE status != 'archived'
         AND (domain = $1 OR domain IS NULL)
       ORDER BY created_at DESC`,
      [domain]
    );
    return rows.map(rowToRecord);
  }

  const { rows } = await pool.query<DeploymentRow>(
    `SELECT * FROM deployments WHERE status != 'archived' ORDER BY created_at DESC`
  );
  return rows.map(rowToRecord);
}

export async function updateSystemStatus(
  slug: string,
  status: DeploymentStatus
): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE deployments SET status = $1, updated_at = now()
     WHERE system_slug = $2 AND status != 'archived'`,
    [status, slug]
  );

  if (rowCount === 0) {
    throw new SystemNotFoundError(slug);
  }
}

/**
 * Update the organizational metadata (domain + tags) for a deployed system.
 * Both fields are optional — undefined means "leave as-is", null/empty array
 * means "clear". The row's core state (canvas, trigger, secrets) is untouched.
 */
export async function updateSystemMetadata(
  slug: string,
  patch: { domain?: string | null; tags?: string[] }
): Promise<DeploymentRecord> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (patch.domain !== undefined) {
    sets.push(`domain = $${paramIndex++}`);
    values.push(patch.domain);
  }
  if (patch.tags !== undefined) {
    sets.push(`tags = $${paramIndex++}::text[]`);
    values.push(patch.tags);
  }

  if (sets.length === 0) {
    // No-op; just return the current record
    const existing = await getSystem(slug);
    if (!existing) throw new SystemNotFoundError(slug);
    return existing;
  }

  sets.push(`updated_at = now()`);
  values.push(slug);

  const { rows } = await pool.query<DeploymentRow>(
    `UPDATE deployments
     SET ${sets.join(', ')}
     WHERE system_slug = $${paramIndex} AND status != 'archived'
     RETURNING *`,
    values
  );

  if (rows.length === 0) {
    throw new SystemNotFoundError(slug);
  }
  return rowToRecord(rows[0]);
}

export async function archiveSystem(slug: string): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE deployments SET status = 'archived', updated_at = now()
     WHERE system_slug = $1 AND status != 'archived'`,
    [slug]
  );

  if (rowCount === 0) {
    throw new SystemNotFoundError(slug);
  }
}

// Import + re-export typed error from shared
import { SystemNotFoundError } from '../lib/errors';
export { SystemNotFoundError };

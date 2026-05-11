// =============================================================================
// Credential Vault Service
//
// Shared storage for API keys, OAuth tokens, and text references. When the
// Fixer identifies a capability gap, the Configure Wizard calls findByProvider
// or findByCapability here before prompting the user. If nothing exists, the
// user fills a typed form (driven by credential-catalog.ts) and the submitted
// value lands here for future reuse.
//
// Security model:
//   - All secret fields are encrypted at rest with ENCRYPTION_KEY (AES-256-GCM,
//     same keys as deployments.secrets_encrypted).
//   - Non-secret fields (region, projectId, tags, etc.) are stored in the
//     plaintext columns/rows for searchability.
//   - When returning credentials to the frontend, `maskSecrets: true` replaces
//     secret values with '••••' so lists can be shown without exposing keys.
//     Unmasked values are only returned on explicit reveal or at deploy time.
// =============================================================================

import { pool } from '../db';
import { encrypt, decrypt } from '../lib/crypto';
import { getProviderAny } from './provider-registry';
import type { ProviderDefinition } from './credential-catalog';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface CredentialRecord {
  id: string;
  orgId: string;
  provider: string;             // provider id from catalog (e.g., 'brave-search')
  name: string;                 // user-given label ('Work Brave key')
  credentialType: string;
  /** Field values keyed by field name. Secret fields are masked unless revealed. */
  values: Record<string, string>;
  tags: string[];
  envVarName: string | null;
  description: string | null;
  usedBySystems: string[];
  lastValidatedAt: string | null;
  lastValidationStatus: string | null;
  lastUsedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCredentialInput {
  orgId?: string;
  provider: string;
  name: string;
  values: Record<string, string>;
  tags?: string[];
  envVarName?: string;
  description?: string;
  createdBy?: string;
}

export interface UpdateCredentialInput {
  name?: string;
  values?: Record<string, string>;
  tags?: string[];
  envVarName?: string;
  description?: string;
}

const DEFAULT_ORG = 'default';
const SECRET_MASK = '••••••••';

// -----------------------------------------------------------------------------
// Row mapping
// -----------------------------------------------------------------------------

interface CredentialRow {
  id: string;
  org_id: string;
  provider: string;
  name: string;
  credential_type: string;
  encrypted_value: string;
  tags: string[];
  env_var_name: string | null;
  description: string | null;
  used_by_systems: string[];
  last_validated_at: string | null;
  last_validation_status: string | null;
  last_used_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: CredentialRow, opts: { maskSecrets: boolean }): CredentialRecord {
  const values = decryptValues(row.encrypted_value);
  const provider = getProviderAny(row.provider);

  const exposed: Record<string, string> = {};
  for (const [key, val] of Object.entries(values)) {
    if (opts.maskSecrets && isSecretField(provider, key)) {
      exposed[key] = SECRET_MASK;
    } else {
      exposed[key] = val;
    }
  }

  return {
    id: row.id,
    orgId: row.org_id,
    provider: row.provider,
    name: row.name,
    credentialType: row.credential_type,
    values: exposed,
    tags: row.tags ?? [],
    envVarName: row.env_var_name,
    description: row.description,
    usedBySystems: row.used_by_systems ?? [],
    lastValidatedAt: row.last_validated_at,
    lastValidationStatus: row.last_validation_status,
    lastUsedAt: row.last_used_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isSecretField(provider: ProviderDefinition | undefined, fieldName: string): boolean {
  if (!provider) return true; // unknown provider → err on masking
  const field = provider.fields.find((f) => f.name === fieldName);
  return field?.secret ?? true;
}

function encryptValues(values: Record<string, string>): string {
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error(
      'ENCRYPTION_KEY is required for credential encryption. '
      + 'Server should not start without it — check startup validation.'
    );
  }
  return encrypt(JSON.stringify(values));
}

function decryptValues(encrypted: string): Record<string, string> {
  try {
    return JSON.parse(decrypt(encrypted)) as Record<string, string>;
  } catch (err) {
    console.warn('[credential-vault] Failed to decrypt values:', err);
    return {};
  }
}

// -----------------------------------------------------------------------------
// CRUD
// -----------------------------------------------------------------------------

export async function createCredential(
  input: CreateCredentialInput
): Promise<CredentialRecord> {
  const provider = getProviderAny(input.provider);
  if (!provider) {
    throw new Error(`Unknown provider: ${input.provider}`);
  }

  // Validate required fields are present
  for (const field of provider.fields) {
    if (field.required && !input.values[field.name]) {
      throw new Error(`Missing required field '${field.name}' for ${provider.name}`);
    }
  }

  const encrypted = encryptValues(input.values);

  const { rows } = await pool.query<CredentialRow>(
    `INSERT INTO credentials (
       org_id, provider, name, credential_type, encrypted_value,
       tags, env_var_name, description, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (org_id, provider, name)
     DO UPDATE SET
       encrypted_value = EXCLUDED.encrypted_value,
       tags = EXCLUDED.tags,
       env_var_name = EXCLUDED.env_var_name,
       description = EXCLUDED.description,
       updated_at = now()
     RETURNING *`,
    [
      input.orgId ?? DEFAULT_ORG,
      input.provider,
      input.name,
      provider.credentialType,
      encrypted,
      input.tags ?? [],
      input.envVarName ?? null,
      input.description ?? null,
      input.createdBy ?? null,
    ]
  );

  return rowToRecord(rows[0], { maskSecrets: true });
}

export async function getCredential(
  id: string,
  opts: { reveal?: boolean } = {}
): Promise<CredentialRecord | null> {
  const { rows } = await pool.query<CredentialRow>(
    `SELECT * FROM credentials WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) return null;
  return rowToRecord(rows[0], { maskSecrets: !opts.reveal });
}

/**
 * Internal helper: fetch a credential with its secrets decrypted.
 * Never expose this to the API — it bypasses the mask. Use only when
 * actually deploying/injecting credentials into an MCP or agent process.
 */
export async function getCredentialDecrypted(
  id: string
): Promise<CredentialRecord | null> {
  return getCredential(id, { reveal: true });
}

export async function findByProvider(
  orgId: string,
  providerId: string
): Promise<CredentialRecord[]> {
  const { rows } = await pool.query<CredentialRow>(
    `SELECT * FROM credentials
     WHERE org_id = $1 AND provider = $2
     ORDER BY last_used_at DESC NULLS LAST, created_at DESC`,
    [orgId, providerId]
  );
  return rows.map((r) => rowToRecord(r, { maskSecrets: true }));
}

/**
 * Find credentials matching a capability tag (e.g., 'web-search'). This walks
 * the provider catalog to find providers with the capability, then queries the
 * vault for credentials stored against those providers. This is how the Fixer
 * checks for existing credentials before prompting the user.
 */
export async function findByCapability(
  orgId: string,
  capability: string
): Promise<CredentialRecord[]> {
  const { rows } = await pool.query<CredentialRow>(
    `SELECT c.*
     FROM credentials c
     WHERE c.org_id = $1
     ORDER BY c.last_used_at DESC NULLS LAST, c.created_at DESC`,
    [orgId]
  );

  // Filter by capability via the catalog (avoids storing capability mappings in the DB)
  return rows
    .filter((row) => {
      const provider = getProviderAny(row.provider);
      return provider?.capabilities.includes(capability) ?? false;
    })
    .map((r) => rowToRecord(r, { maskSecrets: true }));
}

export async function listCredentials(orgId: string = DEFAULT_ORG): Promise<CredentialRecord[]> {
  const { rows } = await pool.query<CredentialRow>(
    `SELECT * FROM credentials
     WHERE org_id = $1
     ORDER BY last_used_at DESC NULLS LAST, created_at DESC`,
    [orgId]
  );
  return rows.map((r) => rowToRecord(r, { maskSecrets: true }));
}

export async function updateCredential(
  id: string,
  input: UpdateCredentialInput
): Promise<CredentialRecord | null> {
  // Fetch existing so we can merge value updates
  const existing = await pool.query<CredentialRow>(
    `SELECT * FROM credentials WHERE id = $1`,
    [id]
  );
  if (existing.rows.length === 0) return null;

  const row = existing.rows[0];
  const currentValues = decryptValues(row.encrypted_value);
  const mergedValues = input.values
    ? { ...currentValues, ...input.values }
    : currentValues;

  const encrypted = input.values ? encryptValues(mergedValues) : row.encrypted_value;

  const { rows } = await pool.query<CredentialRow>(
    `UPDATE credentials
     SET name = COALESCE($2, name),
         encrypted_value = $3,
         tags = COALESCE($4, tags),
         env_var_name = COALESCE($5, env_var_name),
         description = COALESCE($6, description),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      input.name ?? null,
      encrypted,
      input.tags ?? null,
      input.envVarName ?? null,
      input.description ?? null,
    ]
  );

  return rowToRecord(rows[0], { maskSecrets: true });
}

export async function deleteCredential(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM credentials WHERE id = $1`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}

// -----------------------------------------------------------------------------
// Usage tracking
// -----------------------------------------------------------------------------

/**
 * Record that a system is using this credential. Idempotent — appends the
 * slug if it's not already tracked, and always bumps last_used_at.
 */
export async function recordUsage(id: string, systemSlug: string): Promise<void> {
  await pool.query(
    `UPDATE credentials
     SET used_by_systems = CASE
           WHEN $2 = ANY(used_by_systems) THEN used_by_systems
           ELSE array_append(used_by_systems, $2)
         END,
         last_used_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [id, systemSlug]
  );
}

/**
 * Clear usage tracking for a given system (e.g., on archive). Leaves the
 * credential itself in place — it may still be used by other systems.
 */
export async function clearUsageForSystem(systemSlug: string): Promise<void> {
  await pool.query(
    `UPDATE credentials
     SET used_by_systems = array_remove(used_by_systems, $1),
         updated_at = now()
     WHERE $1 = ANY(used_by_systems)`,
    [systemSlug]
  );
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

export type ValidationResult =
  | { status: 'success'; detail?: string }
  | { status: 'failure'; detail: string }
  | { status: 'skipped'; detail: string };

/**
 * Test a stored credential against the provider's validation endpoint.
 * Updates last_validated_at and last_validation_status on the record.
 * Returns a typed result for the caller to display.
 */
export async function validateCredential(id: string): Promise<ValidationResult> {
  const credential = await getCredentialDecrypted(id);
  if (!credential) {
    return { status: 'failure', detail: 'Credential not found' };
  }

  const provider = getProviderAny(credential.provider);
  if (!provider) {
    return { status: 'failure', detail: `Unknown provider: ${credential.provider}` };
  }

  if (!provider.validation) {
    await markValidation(id, 'skipped');
    return { status: 'skipped', detail: 'Provider has no validation endpoint configured' };
  }

  const rule = provider.validation;
  const url = interpolate(rule.url, credential.values);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rule.headers ?? {})) {
    headers[k] = interpolate(v, credential.values);
  }
  const body = rule.body ? interpolate(rule.body, credential.values) : undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), rule.timeoutMs ?? 10000);

  try {
    const response = await fetch(url, {
      method: rule.method,
      headers,
      body,
      signal: controller.signal,
    });

    if (response.status === rule.expectedStatus) {
      await markValidation(id, 'success');
      return { status: 'success', detail: `HTTP ${response.status}` };
    }

    const text = await response.text().catch(() => '');
    const detail = `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
    await markValidation(id, 'failure');
    return { status: 'failure', detail };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await markValidation(id, 'failure');
    return { status: 'failure', detail };
  } finally {
    clearTimeout(timeout);
  }
}

async function markValidation(id: string, status: 'success' | 'failure' | 'skipped'): Promise<void> {
  await pool.query(
    `UPDATE credentials
     SET last_validated_at = now(),
         last_validation_status = $2,
         updated_at = now()
     WHERE id = $1`,
    [id, status]
  );
}

/**
 * Substitute {fieldName} placeholders in a template string with values from
 * the credential. Used for validation URLs, headers, and bodies.
 */
function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? `{${key}}`);
}

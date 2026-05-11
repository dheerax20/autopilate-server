// =============================================================================
// Deploy Bridge Service
// Translates AUTOPILATE canvas state → on-disk system config + DB registry.
// No per-system process is spawned — trigger-executor runs pipelines
// in-process inside the main AUTOPILATE server via OrchestratorCore.
// Atomic deployment: if any step fails, all partial artifacts are cleaned up.
// =============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { pool } from '../db';
import {
  SystemBundle,
  DeploymentRecord,
  AgentConfigSlim,
  MCPServerConfigSlim,
  VaultLink,
} from '../types/registry';
import { registerSystem, updateSystemStatus } from './registry';
import {
  createTriggerConfig,
  removeTriggerConfig,
  TriggerConfig,
} from './trigger-factory';
import {
  getCredentialDecrypted,
  recordUsage as recordCredentialUsage,
} from './credential-vault';
import { getProviderAny } from './provider-registry';
import { DeploymentError } from '../lib/errors';

// Re-export for backward compat in route handlers
export { DeploymentError as DeployError };

interface DeployArtifacts {
  systemDir: string | null;
  mcpConfigDir: string | null;
  triggerConfig: TriggerConfig | null;
  deploymentRecord: DeploymentRecord | null;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Deploy a system bundle.
 *
 * Steps (atomic — rolls back on failure):
 *   1. Write per-agent CLAUDE.md config files under <systemsRoot>/agents/<slug>
 *   2. Write MCP server configs under <systemsRoot>/config/mcp/<slug>
 *   3. Generate trigger configuration (cron / webhook / messaging / daemon)
 *   4. Register in PostgreSQL deployment registry
 *
 * The deployed system has no per-system process. When triggered (cron, Slack,
 * webhook, etc.) trigger-executor.runTriggerExecution() fires
 * executeWorkflow() in-process inside the main AUTOPILATE server — all agent
 * execution happens through OrchestratorCore + the Claude Agent SDK.
 */
export async function deploySystem(
  bundle: SystemBundle,
  systemsRoot: string
): Promise<DeploymentRecord> {
  const { manifest } = bundle;
  const systemSlug = manifest.slug;

  const artifacts: DeployArtifacts = {
    systemDir: null,
    mcpConfigDir: null,
    triggerConfig: null,
    deploymentRecord: null,
  };

  try {
    // Step 0: Resolve any vault-linked credentials into the bundle's envExample
    // before registration. This overrides any literal env values for the same
    // key with the stored vault value. We mutate a shallow copy of the bundle
    // so callers don't observe the resolved secrets.
    const resolvedBundle = await resolveVaultLinks(bundle);

    // Step 1: Write agent config files
    artifacts.systemDir = await writeAgentConfigs(
      resolvedBundle.agentConfigs,
      systemSlug,
      systemsRoot
    );

    // Step 2: Write MCP server configs (with env vars from vault merged)
    artifacts.mcpConfigDir = await writeMcpConfigs(
      resolvedBundle.mcpConfigs,
      systemSlug,
      systemsRoot
    );

    // Step 3: Generate trigger configuration
    artifacts.triggerConfig = await createTriggerConfig(
      manifest.triggerPattern,
      manifest,
      systemsRoot
    );

    // Step 4: Register in deployment registry (uses the resolved envExample)
    artifacts.deploymentRecord = await registerDeployment(
      resolvedBundle,
      artifacts.triggerConfig
    );

    // Step 5: Track credential usage (best-effort — logged on failure)
    if (bundle.vaultLinks && bundle.vaultLinks.length > 0) {
      for (const link of bundle.vaultLinks) {
        try {
          await recordCredentialUsage(link.credentialId, systemSlug);
        } catch (err) {
          console.warn(
            `[deploy-bridge] Failed to record credential usage ${link.credentialId} → ${systemSlug}:`,
            err
          );
        }
      }
    }

    return artifacts.deploymentRecord;
  } catch (err) {
    await rollback(artifacts, systemSlug, systemsRoot);

    if (err instanceof DeploymentError) throw err;
    throw new DeploymentError(
      'FAILED',
      `Deployment failed for ${systemSlug}: ${err instanceof Error ? err.message : String(err)}`,
      'unknown',
      err
    );
  }
}

// -----------------------------------------------------------------------------
// Step 0: Resolve vault links into envExample + MCP configs
// -----------------------------------------------------------------------------

/**
 * Look up each vault link, decrypt the credential, and merge the typed field
 * value into the bundle's envExample + any MCP configs that reference the
 * same env var. Vault values win over literal envExample values when both
 * are present — this lets bundles carry placeholder values that get replaced
 * with real secrets at deploy time.
 */
async function resolveVaultLinks(bundle: SystemBundle): Promise<SystemBundle> {
  const vaultLinks = bundle.vaultLinks ?? [];
  if (vaultLinks.length === 0) return bundle;

  const resolvedEnv: Record<string, string> = { ...bundle.envExample };

  for (const link of vaultLinks) {
    const value = await resolveVaultLink(link);
    if (value === null) {
      // Credential is gone or couldn't be resolved — leave placeholder alone
      // and let the user discover the missing env var when the system runs.
      // A warning is emitted so the deploy log flags it.
      console.warn(
        `[deploy-bridge] Vault link ${link.credentialId} → ${link.envVarName} could not be resolved (credential missing or invalid)`
      );
      continue;
    }
    resolvedEnv[link.envVarName] = value;
  }

  // Also propagate into MCP configs. Each MCP config has its own env map;
  // for each env var the MCP references, if the vault has a value, inject it.
  const resolvedMcpConfigs: MCPServerConfigSlim[] = bundle.mcpConfigs.map((mcp) => {
    if (!mcp.env) return mcp;
    const mergedEnv: Record<string, string> = { ...mcp.env };
    for (const [k] of Object.entries(mcp.env)) {
      if (resolvedEnv[k] !== undefined && resolvedEnv[k] !== '') {
        mergedEnv[k] = resolvedEnv[k];
      }
    }
    return { ...mcp, env: mergedEnv };
  });

  return {
    ...bundle,
    envExample: resolvedEnv,
    mcpConfigs: resolvedMcpConfigs,
  };
}

/**
 * Look up a single vault credential and extract the value for the requested
 * field. Uses the provider catalog to pick a default field name when the
 * link doesn't specify one.
 */
async function resolveVaultLink(link: VaultLink): Promise<string | null> {
  const credential = await getCredentialDecrypted(link.credentialId);
  if (!credential) return null;

  const provider = getProviderAny(credential.provider);
  const fieldName =
    link.fieldName
    ?? provider?.fields.find((f) => f.required && f.secret)?.name
    ?? provider?.fields[0]?.name;

  if (!fieldName) return null;
  return credential.values[fieldName] ?? null;
}

// -----------------------------------------------------------------------------
// Step 1: Write per-agent CLAUDE.md files
// -----------------------------------------------------------------------------

async function writeAgentConfigs(
  agentConfigs: Record<string, AgentConfigSlim>,
  systemSlug: string,
  systemsRoot: string
): Promise<string> {
  const systemDir = path.join(systemsRoot, 'agents', systemSlug);

  for (const [agentSlug, config] of Object.entries(agentConfigs)) {
    const agentDir = path.join(systemDir, agentSlug);
    await fs.mkdir(agentDir, { recursive: true });

    const claudeMd = generateAgentClaudeMd(config, agentSlug, systemSlug);
    await fs.writeFile(path.join(agentDir, 'CLAUDE.md'), claudeMd, 'utf-8');
  }

  return systemDir;
}

function generateAgentClaudeMd(
  config: AgentConfigSlim,
  _agentSlug: string,
  systemSlug: string
): string {
  const sections: string[] = [`# ${config.name}\n\nSystem: ${systemSlug}\nRole: ${config.role}`];
  if (config.description) sections.push(`## Description\n\n${config.description}`);
  if (config.systemPrompt) sections.push(`## System Prompt\n\n${config.systemPrompt}`);
  if (config.provider) {
    const model = config.model ? `\n- Model: ${config.model}` : '';
    sections.push(`## Model Configuration\n\n- Provider: ${config.provider}${model}`);
  }
  if (config.mcps.length > 0) {
    sections.push(`## MCP Servers\n\n${config.mcps.map((m) => `- ${m}`).join('\n')}`);
  }
  return sections.join('\n\n') + '\n';
}

// -----------------------------------------------------------------------------
// Step 2: Write MCP server configs
// -----------------------------------------------------------------------------

async function writeMcpConfigs(
  mcpConfigs: MCPServerConfigSlim[],
  systemSlug: string,
  systemsRoot: string
): Promise<string> {
  const mcpDir = path.join(systemsRoot, 'config', 'mcp', systemSlug);
  await fs.mkdir(mcpDir, { recursive: true });

  for (const config of mcpConfigs) {
    const fileName = `${config.name}.json`;
    const configPayload = {
      name: config.name,
      command: config.command,
      args: config.args ?? [],
      env: config.env ?? {},
    };

    await fs.writeFile(
      path.join(mcpDir, fileName),
      JSON.stringify(configPayload, null, 2),
      'utf-8'
    );
  }

  return mcpDir;
}

// -----------------------------------------------------------------------------
// Step 4: Register deployment with trigger config
// -----------------------------------------------------------------------------

async function registerDeployment(
  bundle: SystemBundle,
  triggerConfig: TriggerConfig
): Promise<DeploymentRecord> {
  const record = await registerSystem(bundle);

  // Update the trigger_config and openclaw_config columns
  await pool.query(
    `UPDATE deployments
     SET trigger_config = $1::jsonb,
         openclaw_config = $2::jsonb,
         updated_at = now()
     WHERE id = $3`,
    [
      JSON.stringify(triggerConfig),
      JSON.stringify({
        agentDir: `agents/${bundle.manifest.slug}`,
        mcpDir: `config/mcp/${bundle.manifest.slug}`,
        triggerFile: `config/triggers/${bundle.manifest.slug}.json`,
      }),
      record.id,
    ]
  );

  return {
    ...record,
    triggerConfig,
    openclawConfig: {
      agentDir: `agents/${bundle.manifest.slug}`,
      mcpDir: `config/mcp/${bundle.manifest.slug}`,
      triggerFile: `config/triggers/${bundle.manifest.slug}.json`,
    },
  };
}

// -----------------------------------------------------------------------------
// Rollback: Clean up partial artifacts on failure
// -----------------------------------------------------------------------------

async function rollback(
  artifacts: DeployArtifacts,
  systemSlug: string,
  systemsRoot: string
): Promise<void> {
  const errors: string[] = [];

  const cleanupSteps: Array<{ guard: unknown; label: string; fn: () => Promise<void> }> = [
    { guard: artifacts.deploymentRecord, label: 'Registry', fn: () => updateSystemStatus(systemSlug, 'errored') },
    { guard: artifacts.triggerConfig, label: 'Trigger', fn: () => removeTriggerConfig(systemSlug, systemsRoot) },
    { guard: artifacts.mcpConfigDir, label: 'MCP config', fn: () => fs.rm(artifacts.mcpConfigDir!, { recursive: true, force: true }) },
    { guard: artifacts.systemDir, label: 'Agent dir', fn: () => fs.rm(artifacts.systemDir!, { recursive: true, force: true }) },
  ];

  for (const step of cleanupSteps) {
    if (!step.guard) continue;
    try {
      await step.fn();
    } catch (err) {
      errors.push(`${step.label} cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length > 0) {
    console.error(`[deploy-bridge] Rollback encountered errors:\n  ${errors.join('\n  ')}`);
  }
}

// =============================================================================
// Deployment Registry Types (server-side, no React Flow dependency)
// =============================================================================

export type TriggerPattern = 'cron' | 'webhook' | 'messaging' | 'always-on';

export type SystemCategory =
  | 'web-development'
  | 'content-production'
  | 'research'
  | 'data-analysis'
  | 'monitoring';

export type SystemOutputType = 'web_artifact' | 'document' | 'data' | 'notification';

export type DeploymentStatus = 'deployed' | 'stopped' | 'errored' | 'archived';

/** Context needed to send execution results back to the user who triggered it. */
export interface ReplyContext {
  replyTo: string;
  replyChannel?: string;
  replyAgentId?: string;
}

export interface RequiredInput {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

export interface SystemManifest {
  name: string;
  slug: string;
  description: string;
  version: string;
  category: SystemCategory;
  requiredInputs: RequiredInput[];
  outputType: SystemOutputType;
  estimatedCostUsd: number;
  triggerPattern: TriggerPattern;
  nodeCount: number;
  edgeCount: number;
}

// PM2 config types — kept so pm2-manager.ts can continue managing the main
// AUTOPILATE server process (and any other long-running processes the user
// registers manually). Per-system bundles no longer carry a PM2 ecosystem —
// deploy-bridge does not spawn per-system processes; trigger-executor runs
// deployed systems in-process via OrchestratorCore.
export interface PM2AppConfig {
  name: string;
  script: string;
  args?: string[];
  cwd?: string;
  interpreter?: string;
  env?: Record<string, string>;
  instances?: number;
  max_memory_restart?: string;
  cron_restart?: string;
  autorestart?: boolean;
  watch?: boolean;
  max_restarts?: number;
  restart_delay?: number;
}

export interface PM2EcosystemConfig {
  apps: PM2AppConfig[];
}

// Minimal agent config shape for deploy bridge (avoids React Flow dependency)
export interface AgentConfigSlim {
  name: string;
  role: string;
  description?: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  mcps: string[];
  [key: string]: unknown;
}

// Minimal MCP server config shape for deploy bridge
export interface MCPServerConfigSlim {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * A link from an env var name to a stored credential in the vault. At deploy
 * time, deploy-bridge resolves each link, decrypts the credential, and merges
 * the typed field values into the system's envExample (overriding any literal
 * values for the same env var). This is how "use an existing vault key"
 * propagates to runtime.
 */
export interface VaultLink {
  /** The env var name the system's configs reference (e.g., 'BRAVE_API_KEY'). */
  envVarName: string;
  /** Vault credential id to look up at deploy time. */
  credentialId: string;
  /**
   * Optional field name when the credential is multi_field — selects which
   * stored field maps to this env var. Defaults to the provider's first
   * required field (typically 'apiKey').
   */
  fieldName?: string;
}

export interface SystemBundle {
  manifest: SystemManifest;
  canvasJson: unknown;
  agentConfigs: Record<string, AgentConfigSlim>;
  mcpConfigs: MCPServerConfigSlim[];
  envExample: Record<string, string>;
  /** Optional links from env var names to stored vault credentials. */
  vaultLinks?: VaultLink[];
  createdAt: string;
  /**
   * @deprecated Retained for backward compatibility with bundles produced
   * before the OpenClaw retirement. Never populated by current exports and
   * never consumed by the deploy bridge. New code should not read this.
   */
  pm2Ecosystem?: PM2EcosystemConfig;
}

export interface DeploymentRecord {
  id: string;
  systemName: string;
  systemSlug: string;
  manifestJson: SystemManifest;
  canvasJson: unknown;
  openclawConfig: unknown;
  triggerType: TriggerPattern;
  triggerConfig: unknown;
  pm2ProcessName: string;
  secretsDecrypted: Record<string, string> | null;
  status: DeploymentStatus;
  /** Supervisor domain. NULL = global (visible across all supervisors). */
  domain: string | null;
  /** Free-form labels for cross-cutting filtering (owner:x, cost:high, etc). */
  tags: string[];
  deployedAt: string;
  createdAt: string;
  updatedAt: string;
}

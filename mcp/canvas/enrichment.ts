// =============================================================================
// Node Config Enrichment
// Type normalization and default config generators for all node types
// =============================================================================

// =============================================================================
// Node Type Normalization
// =============================================================================
// Maps lowercase-hyphenated types from Architect/Builder to UPPERCASE_UNDERSCORE
// types expected by the frontend schema system.

const NODE_TYPE_MAP: Record<string, string> = {
  // Standard types (lowercase -> UPPERCASE)
  'agent': 'AGENT',
  'skill': 'SKILL',
  'plugin': 'PLUGIN',
  'tool': 'TOOL',
  'provider': 'PROVIDER',
  'hook': 'HOOK',
  'command': 'COMMAND',
  'reasoning': 'REASONING',
  'department': 'DEPARTMENT',
  'agent-pool': 'AGENT_POOL',
  'mcp-server': 'MCP_SERVER',

  // Already uppercase (passthrough)
  'AGENT': 'AGENT',
  'SKILL': 'SKILL',
  'PLUGIN': 'PLUGIN',
  'TOOL': 'TOOL',
  'PROVIDER': 'PROVIDER',
  'HOOK': 'HOOK',
  'COMMAND': 'COMMAND',
  'REASONING': 'REASONING',
  'DEPARTMENT': 'DEPARTMENT',
  'AGENT_POOL': 'AGENT_POOL',
  'MCP_SERVER': 'MCP_SERVER',
};

/**
 * Normalize a node type string to the UPPERCASE_UNDERSCORE format
 * expected by the frontend schema system.
 *
 * @param type - Input type (e.g., 'agent', 'agent-pool', 'mcp-server')
 * @returns Normalized type (e.g., 'AGENT', 'AGENT_POOL', 'MCP_SERVER')
 */
export function normalizeNodeType(type: string): string {
  // First check direct mapping
  if (NODE_TYPE_MAP[type]) {
    return NODE_TYPE_MAP[type];
  }

  // Fallback: convert to uppercase and replace hyphens with underscores
  const normalized = type.toUpperCase().replace(/-/g, '_');

  // Warn if this is an unknown type
  console.warn(`[Canvas] Unknown node type "${type}" normalized to "${normalized}"`);

  return normalized;
}

/**
 * Phase 6.2: Generate a default system prompt for agents that don't have one.
 * This ensures agents are not "empty shells" when created.
 */
function generateDefaultSystemPrompt(label: string, role?: string): string {
  const agentRole = role || 'executor';
  return `You are ${label}, an AI agent specialized in ${agentRole} tasks.

Your responsibilities:
- Execute tasks efficiently and report status clearly
- Collaborate with other agents when needed
- Follow the established workflow patterns

Always be helpful, accurate, and concise in your responses.`;
}

// =============================================================================
// Phase 7: Comprehensive Node Defaults
// =============================================================================
// When nodes are created by the Builder, they often arrive with sparse config.
// These defaults ensure every node type is "ready to run" out of the box.

/**
 * Infer the best model for an agent based on its role.
 * Leaders/orchestrators get Opus, specialists get Sonnet.
 */
function inferModel(role?: string): string {
  const leaderRoles = ['orchestrator', 'leader', 'router', 'director', 'supervisor'];
  if (role && leaderRoles.some(r => role.toLowerCase().includes(r))) {
    return 'claude-opus-4-20250514';
  }
  return 'claude-sonnet-4-20250514';
}

/**
 * Infer the temperature for an agent based on its role.
 * Creative roles get higher temp, analytical roles get lower.
 */
function inferTemperature(role?: string, label?: string): number {
  const creativeKeywords = ['writer', 'script', 'creative', 'brief', 'outreach', 'content'];
  const analyticalKeywords = ['analyst', 'assessment', 'risk', 'legal', 'normaliz', 'parser', 'monitor', 'audit'];
  const combined = `${role || ''} ${label || ''}`.toLowerCase();
  if (creativeKeywords.some(k => combined.includes(k))) return 0.8;
  if (analyticalKeywords.some(k => combined.includes(k))) return 0.3;
  return 0.7;
}

/**
 * Infer permissions based on the agent's role and label.
 * Returns flat keys matching the schema field keys in schemas.ts.
 */
function inferPermissions(role?: string, label?: string): Record<string, unknown> {
  const combined = `${role || ''} ${label || ''}`.toLowerCase();
  const isLeader = ['lead', 'director', 'supervisor', 'orchestrator'].some(k => combined.includes(k));
  return {
    permissionMode: isLeader ? 'bypassPermissions' : 'default',
    disallowedTools: [],
    requiresApprovalFor: isLeader ? [] : ['Shell Commands'],
  };
}

/**
 * Infer role category from role string.
 */
// Phase 7.1: Values MUST match the lowercase AgentRoleCategory type in core.ts:
// 'independent' | 'team' | 'coordinator' | 'continuous'
function inferRoleCategory(role: string): string {
  const r = role.toLowerCase();
  if (['solo', 'specialist', 'planner', 'auditor', 'critic'].includes(r)) return 'independent';
  if (['leader', 'orchestrator', 'router', 'director', 'supervisor'].some(k => r.includes(k))) return 'coordinator';
  if (['monitor'].some(k => r.includes(k))) return 'continuous';
  return 'team'; // member, executor, etc.
}

/**
 * Generate comprehensive defaults for an AGENT node.
 *
 * CRITICAL: Field keys MUST match the schema field keys in schemas.ts exactly.
 * The DynamicForm uses react-hook-form with these keys to read/write values.
 *
 * Schema uses DOT NOTATION for nested fields:
 *   - 'guardrails.tokenLimit' (NOT flat 'tokenLimit')
 *   - 'observability.logging.level' (NOT flat 'logLevel')
 *   - 'memory.contextPersistence' (NOT flat 'contextPersistence')
 *
 * But FLAT keys for top-level fields:
 *   - 'provider', 'model', 'temperature', 'role', 'permissionMode', etc.
 */
function enrichAgentConfig(label: string, incoming: Record<string, unknown>): Record<string, unknown> {
  const role = (incoming.role as string) || 'specialist';
  const model = (incoming.model as string) || inferModel(role);
  const temperature = (incoming.temperature as number) ?? inferTemperature(role, label);
  const permissions = inferPermissions(role, label);

  // Infer guardrail values based on agent purpose
  const combined = `${role} ${label}`.toLowerCase();
  const isOutward = ['outreach', 'email', 'follow-up', 'script'].some(k => combined.includes(k));

  const defaults: Record<string, unknown> = {
    // Identity section
    label: label,
    description: incoming.description || `${label} - ${role} agent`,
    teamName: '',

    // Agent Role section
    roleCategory: inferRoleCategory(role),
    role: role,

    // Model section
    provider: 'anthropic',
    model: model,
    temperature: temperature,
    thinkingMode: '',
    contextWindow: '',
    reservedOutputTokens: '',

    // Permissions section
    ...permissions,

    // Capabilities section
    skills: [],
    mcps: [],
    commands: [],

    // System Prompt section
    systemPrompt: generateDefaultSystemPrompt(label, role),

    // Advanced section
    maxTokens: 4096,
    topP: 0.1,
    failoverChain: [],

    // Guardrails section (DOT-NOTATION keys matching schemas.ts)
    'guardrails.tokenLimit': 100000,
    'guardrails.costCap': 10.00,
    'guardrails.timeoutSeconds': 300,
    'guardrails.maxRetries': 3,
    'guardrails.contentFilters.profanity': true,
    'guardrails.contentFilters.pii': isOutward,
    'guardrails.contentFilters.injection': true,

    // Observability section (DOT-NOTATION keys matching schemas.ts)
    'observability.logging.level': 'info',
    'observability.logging.destinations': ['console'],
    'observability.metrics.enabled': true,
    'observability.metrics.exportInterval': 60,
    'observability.tracing.enabled': false,
    'observability.tracing.samplingRate': 0.1,

    // Memory & Context section (DOT-NOTATION keys matching schemas.ts)
    'memory.contextPersistence': 'session',
    'memory.memoryType': 'conversation',
    'memory.maxContextTokens': 8000,
    'memory.summarizationThreshold': 6000,
  };

  // Overlay incoming values (skip empty strings)
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== '' && value !== undefined && value !== null) {
      defaults[key] = value;
    }
  }

  return defaults;
}

/**
 * Generate defaults for a HOOK node.
 */
function enrichHookConfig(label: string, incoming: Record<string, unknown>): Record<string, unknown> {
  return {
    name: label,
    description: incoming.description || `${label} hook`,
    event: incoming.event || 'PostToolUse',
    command: incoming.command || 'echo "Hook triggered"',
    matcher: incoming.matcher || '*',
    ...incoming,
  };
}

/**
 * Generate defaults for an MCP_SERVER node.
 */
function enrichMCPConfig(label: string, incoming: Record<string, unknown>): Record<string, unknown> {
  return {
    name: label,
    description: incoming.description || `${label} MCP server`,
    command: incoming.command || 'npx',
    args: incoming.args || [],
    env: incoming.env || {},
    ...incoming,
  };
}

/**
 * Generate defaults for a COMMAND node.
 */
function enrichCommandConfig(label: string, incoming: Record<string, unknown>): Record<string, unknown> {
  return {
    name: label,
    description: incoming.description || `${label} command`,
    content: incoming.content || '',
    triggers: incoming.triggers || [],
    ...incoming,
  };
}

/**
 * Generate defaults for a SKILL node.
 */
function enrichSkillConfig(label: string, incoming: Record<string, unknown>): Record<string, unknown> {
  return {
    name: label,
    description: incoming.description || `${label} skill`,
    content: incoming.content || '',
    whenToUse: incoming.whenToUse || '',
    whenNotToUse: incoming.whenNotToUse || '',
    triggers: incoming.triggers || [],
    ...incoming,
  };
}

/**
 * Phase 7: Master enrichment dispatcher.
 * Routes to the appropriate enrichment function based on node type.
 */
export function enrichNodeConfig(type: string, label: string, incoming: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case 'AGENT':
      return enrichAgentConfig(label, incoming);
    case 'HOOK':
      return enrichHookConfig(label, incoming);
    case 'MCP_SERVER':
      return enrichMCPConfig(label, incoming);
    case 'COMMAND':
      return enrichCommandConfig(label, incoming);
    case 'SKILL':
      return enrichSkillConfig(label, incoming);
    case 'DEPARTMENT':
      return { name: label, description: incoming.description || `${label} department`, color: incoming.color || 'slate', priority: incoming.priority || 5, ...incoming };
    case 'AGENT_POOL':
      return { name: label, description: incoming.description || `${label} pool`, scalingPolicy: incoming.scalingPolicy || 'fixed', ...incoming };
    default:
      return { name: label, ...incoming };
  }
}

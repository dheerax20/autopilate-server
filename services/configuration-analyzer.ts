// =============================================================================
// Configuration Analyzer Service
// Deterministic workflow scanning + AI-powered per-node configuration analysis
// =============================================================================

import Anthropic from '@anthropic-ai/sdk';
import type {
  WorkflowAnalysis,
  NodeIssue,
  MissingRequirement,
  ConfigSuggestion,
} from '../shared/socket-events';
import { COST_PER_NODE_ESTIMATE } from '../config/model-pricing';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnalysisNode {
  id: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
}

interface AnalysisEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
}

interface WorkflowContext {
  nodeCount: number;
  edgeCount: number;
  connectedNodes: Array<{ type: string; label: string }>;
  workflowName: string;
}

interface LlmSuggestionResponse {
  field: string;
  currentValue: unknown;
  suggestedValue: unknown;
  reason: string;
  priority?: string;
}

interface LlmRequirementResponse {
  type?: string;
  description: string;
  solution: string;
  category?: string;
}

interface LlmAnalysisResponse {
  summary?: string;
  overallScore?: number;
  suggestions?: LlmSuggestionResponse[];
  missingRequirements?: LlmRequirementResponse[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIGURABLE_TYPES = ['AGENT', 'MCP_SERVER', 'HOOK', 'COMMAND', 'SKILL'];
const SECRET_PATTERNS = /key|token|secret|password|credential|auth/i;

// ---------------------------------------------------------------------------
// Secret Masking
// ---------------------------------------------------------------------------

function maskSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...config };

  // Mask env key-value pairs
  if (masked.env && typeof masked.env === 'object') {
    const env = { ...(masked.env as Record<string, string>) };
    for (const key of Object.keys(env)) {
      if (SECRET_PATTERNS.test(key)) {
        env[key] = `[REDACTED - env var: ${key}]`;
      }
    }
    masked.env = env;
  }

  // Mask environment key-value pairs (hooks)
  if (masked.environment && typeof masked.environment === 'object') {
    const environment = { ...(masked.environment as Record<string, string>) };
    for (const key of Object.keys(environment)) {
      if (SECRET_PATTERNS.test(key)) {
        environment[key] = `[REDACTED - env var: ${key}]`;
      }
    }
    masked.environment = environment;
  }

  // Mask auth fields
  if (masked.auth && typeof masked.auth === 'object') {
    const auth = { ...(masked.auth as Record<string, unknown>) };
    if (auth.envVar && typeof auth.envVar === 'string' && SECRET_PATTERNS.test(auth.envVar)) {
      // Keep the env var name but note it's a credential reference
      auth._note = `References credential in environment variable: ${auth.envVar}`;
    }
    masked.auth = auth;
  }

  return masked;
}

// ---------------------------------------------------------------------------
// Workflow Analysis (Deterministic Rules Engine — No AI)
// ---------------------------------------------------------------------------

export function analyzeWorkflow(
  nodes: AnalysisNode[],
  edges: AnalysisEdge[]
): WorkflowAnalysis {
  const issues: NodeIssue[] = [];
  const requirements: MissingRequirement[] = [];

  // Build adjacency map
  const connectedNodeIds = new Set<string>();
  for (const edge of edges) {
    connectedNodeIds.add(edge.source);
    connectedNodeIds.add(edge.target);
  }

  for (const node of nodes) {
    const config = node.config || {};
    const type = (node.type || '').toUpperCase();

    // --- AGENT checks ---
    if (type === 'AGENT') {
      if (!config.systemPrompt || (config.systemPrompt as string).trim().length < 10) {
        issues.push({
          nodeId: node.id,
          nodeLabel: node.label,
          severity: 'warning',
          message: 'System prompt is missing or too short',
          solution: 'Add a detailed system prompt describing the agent\'s role and capabilities',
        });
      }

      if (!config.model) {
        issues.push({
          nodeId: node.id,
          nodeLabel: node.label,
          severity: 'info',
          message: 'No model specified — will default to claude-sonnet-4-5-20250929',
          solution: 'Set an explicit model in the properties panel',
        });
      }

      const hasCapabilities =
        (Array.isArray(config.tools) && config.tools.length > 0) ||
        (Array.isArray(config.skills) && config.skills.length > 0) ||
        (Array.isArray(config.mcps) && config.mcps.length > 0);

      if (!hasCapabilities) {
        issues.push({
          nodeId: node.id,
          nodeLabel: node.label,
          severity: 'info',
          message: 'Agent has no tools, skills, or MCPs assigned',
          solution: 'Consider adding capabilities to enhance the agent\'s effectiveness',
        });
      }
    }

    // --- MCP_SERVER checks ---
    if (type === 'MCP_SERVER') {
      if (!config.command || (config.command as string).trim() === '') {
        issues.push({
          nodeId: node.id,
          nodeLabel: node.label,
          severity: 'error',
          message: 'MCP server command is required but missing',
          solution: 'Set the command to start this MCP server (e.g., "npx", "node", "python")',
        });
      }

      const authType = (config.auth as Record<string, unknown>)?.type;
      if (authType && authType !== 'none') {
        const envVar = (config.auth as Record<string, unknown>)?.envVar;
        if (!envVar || (envVar as string).trim() === '') {
          requirements.push({
            type: 'api_key',
            description: `${node.label} requires authentication but no credential env var is configured`,
            solution: `Set auth.envVar to the environment variable name containing your API key (e.g., GITHUB_TOKEN). Then ensure that variable is set in your shell: export GITHUB_TOKEN=your_key`,
            nodeId: node.id,
            nodeLabel: node.label,
            category: 'manual',
          });
        }
      }
    }

    // --- HOOK checks ---
    if (type === 'HOOK') {
      if (!config.event) {
        issues.push({
          nodeId: node.id,
          nodeLabel: node.label,
          severity: 'error',
          message: 'Hook event trigger is required but not set',
          solution: 'Select an event type (PreToolUse, PostToolUse, Notification, Stop)',
        });
      }

      if (!config.command || (config.command as string).trim() === '') {
        issues.push({
          nodeId: node.id,
          nodeLabel: node.label,
          severity: 'error',
          message: 'Hook command is required but missing',
          solution: 'Set the shell command to execute when this hook triggers',
        });
      }
    }

    // --- COMMAND checks ---
    if (type === 'COMMAND') {
      if (!config.description || (config.description as string).trim() === '') {
        issues.push({
          nodeId: node.id,
          nodeLabel: node.label,
          severity: 'warning',
          message: 'Command has no description',
          solution: 'Add a description so users know what this command does',
        });
      }
    }

    // --- Orphaned node check ---
    if (!connectedNodeIds.has(node.id) && nodes.length > 1) {
      issues.push({
        nodeId: node.id,
        nodeLabel: node.label,
        severity: 'warning',
        message: 'Node has no connections — it won\'t participate in the workflow',
        solution: 'Connect this node to other nodes via edges, or remove it',
      });
    }
  }

  // Build analysis order: AGENTs first, then MCPs, HOOKs, COMMANDs, SKILLs
  const typeOrder: Record<string, number> = {
    AGENT: 0,
    MCP_SERVER: 1,
    HOOK: 2,
    COMMAND: 3,
    SKILL: 4,
  };

  const configurableNodes = nodes
    .filter((n) => CONFIGURABLE_TYPES.includes((n.type || '').toUpperCase()))
    .sort((a, b) => {
      const aOrder = typeOrder[(a.type || '').toUpperCase()] ?? 99;
      const bOrder = typeOrder[(b.type || '').toUpperCase()] ?? 99;
      return aOrder - bOrder;
    });

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;

  const overallHealth: WorkflowAnalysis['overallHealth'] =
    errorCount > 0 ? 'critical' : warningCount > 2 ? 'needs-attention' : 'good';

  return {
    overallHealth,
    nodeIssues: issues,
    missingRequirements: requirements,
    orderOfAnalysis: configurableNodes.map((n) => n.id),
    configurableNodeCount: configurableNodes.length,
    estimatedCost: configurableNodes.length * COST_PER_NODE_ESTIMATE,
  };
}

// ---------------------------------------------------------------------------
// Prompt Templates
// ---------------------------------------------------------------------------

function buildAgentPrompt(config: Record<string, unknown>, context: WorkflowContext): string {
  return `You are a Claude Code agent configuration expert. Analyze this AGENT configuration and suggest optimal settings.

## Current Configuration
\`\`\`json
${JSON.stringify(config, null, 2)}
\`\`\`

## Workflow Context
- Workflow: "${context.workflowName}"
- Total nodes: ${context.nodeCount}, Total edges: ${context.edgeCount}
- Connected to: ${context.connectedNodes.map((n) => `${n.label} (${n.type})`).join(', ') || 'none'}

## Analysis Instructions
Review each configuration field and suggest improvements:

1. **model** — Is the model appropriate for this agent's role? When suggesting models, use ONLY these exact model IDs:
   - claude-opus-4-6 (most intelligent, for complex reasoning/orchestration)
   - claude-sonnet-4-5-20250929 (best speed+intelligence, for general tasks)
   - claude-haiku-4-5-20251001 (fastest, for simple/fast tasks)
   - gemini-3-pro-preview (Google's best reasoning model)
   - gemini-3-flash-preview (Google's fast model)
2. **temperature** — Is it appropriate? Code generation should be 0.1-0.3, creative tasks 0.7-0.9, analysis 0.2-0.5.
3. **maxTokens** — Is the limit reasonable for the expected output length?
4. **systemPrompt** — Is it clear, specific, and well-structured? Does it define the agent's role, capabilities, and output format?
5. **guardrails** — Are timeout, cost cap, and retry settings configured?
6. **tools/skills/mcps** — Are the right capabilities assigned for the task?
7. **permissionMode** — Is the security level appropriate?

IMPORTANT: The "suggestions" array MUST include EVERY configurable field from the config — not just fields you want to change.
- For fields that need changes: set suggestedValue to your recommended value, priority to "high", "medium", or "low".
- For fields that are already optimal: set suggestedValue EQUAL to currentValue and priority to "none".

Respond in this EXACT JSON format (no markdown fences, just raw JSON):
{
  "summary": "One sentence overall assessment",
  "overallScore": 7,
  "suggestions": [
    {
      "field": "fieldName",
      "currentValue": "current value or null",
      "suggestedValue": "suggested or same value",
      "reason": "Why this is good as-is / Why this change improves it",
      "priority": "high|medium|low|none"
    }
  ],
  "missingRequirements": [
    {
      "type": "config_field",
      "description": "What is missing",
      "solution": "How to fix it",
      "category": "auto_fixable or manual"
    }
  ]
}

IMPORTANT for missingRequirements category:
- "auto_fixable": Things an AI agent can do — create directories, create config files, add env var placeholders to .env, write boilerplate code, set up default configurations
- "manual": Things requiring human action — obtaining API keys from external services, purchasing subscriptions, manual account setup, getting credentials`;
}

function buildMcpPrompt(config: Record<string, unknown>, context: WorkflowContext): string {
  return `You are a Claude Code MCP server configuration expert. Analyze this MCP_SERVER configuration and suggest optimal settings.

## Current Configuration
\`\`\`json
${JSON.stringify(config, null, 2)}
\`\`\`

## Workflow Context
- Workflow: "${context.workflowName}"
- Connected to: ${context.connectedNodes.map((n) => `${n.label} (${n.type})`).join(', ') || 'none'}

## Analysis Instructions
1. **command** — Is it a valid command to start this MCP server?
2. **args** — Are the arguments correct and complete?
3. **env** — Are all required environment variables defined? Are any values missing?
4. **auth** — Is authentication properly configured? Is the env var for credentials specified?
5. **rateLimit** — Are rate limits set to prevent overuse?
6. **timeout** — Is the timeout reasonable?
7. **retryCount** — Are retries configured for resilience?

Flag any environment variables that appear to need API keys or tokens that the user must obtain.

IMPORTANT: The "suggestions" array MUST include EVERY configurable field from the config — not just fields you want to change.
- For fields that need changes: set suggestedValue to your recommended value, priority to "high", "medium", or "low".
- For fields that are already optimal: set suggestedValue EQUAL to currentValue and priority to "none".

Respond in this EXACT JSON format (no markdown fences, just raw JSON):
{
  "summary": "One sentence overall assessment",
  "overallScore": 7,
  "suggestions": [
    {
      "field": "fieldName",
      "currentValue": "current value or null",
      "suggestedValue": "suggested or same value",
      "reason": "Why this is good as-is / Why this change improves it",
      "priority": "high|medium|low|none"
    }
  ],
  "missingRequirements": [
    {
      "type": "api_key",
      "description": "What API key or credential is needed",
      "solution": "Step-by-step instructions to obtain it",
      "category": "auto_fixable or manual"
    }
  ]
}

IMPORTANT for missingRequirements category:
- "auto_fixable": Things an AI agent can do — create directories, create config files, add env var placeholders to .env, write boilerplate code
- "manual": Things requiring human action — obtaining API keys from external services, purchasing subscriptions, manual account setup`;
}

function buildHookPrompt(config: Record<string, unknown>, context: WorkflowContext): string {
  return `You are a Claude Code hook configuration expert. Analyze this HOOK configuration and suggest optimal settings.

## Current Configuration
\`\`\`json
${JSON.stringify(config, null, 2)}
\`\`\`

## Workflow Context
- Workflow: "${context.workflowName}"
- Connected to: ${context.connectedNodes.map((n) => `${n.label} (${n.type})`).join(', ') || 'none'}

## Analysis Instructions
1. **event** — Is the trigger event appropriate? (PreToolUse, PostToolUse, Notification, Stop)
2. **matcher** — Is the tool name pattern correctly scoped?
3. **command** — Is the shell command valid and safe? Does it reference the right scripts/tools?
4. **timeout** — Is the timeout reasonable for the command?
5. **onError** — Is error handling configured (fail, ignore, warn)?
6. **environment** — Are required environment variables set?

Flag any commands that appear to need credentials or API keys the user must provide.

IMPORTANT: The "suggestions" array MUST include EVERY configurable field from the config — not just fields you want to change.
- For fields that need changes: set suggestedValue to your recommended value, priority to "high", "medium", or "low".
- For fields that are already optimal: set suggestedValue EQUAL to currentValue and priority to "none".

Respond in this EXACT JSON format (no markdown fences, just raw JSON):
{
  "summary": "One sentence overall assessment",
  "overallScore": 7,
  "suggestions": [
    {
      "field": "fieldName",
      "currentValue": "current value or null",
      "suggestedValue": "suggested or same value",
      "reason": "Why this is good as-is / Why this change improves it",
      "priority": "high|medium|low|none"
    }
  ],
  "missingRequirements": [
    {
      "type": "env_var",
      "description": "What is needed",
      "solution": "How to set it up",
      "category": "auto_fixable or manual"
    }
  ]
}

IMPORTANT for missingRequirements category:
- "auto_fixable": Things an AI agent can do — create directories, create config files, add env var placeholders to .env, write boilerplate code
- "manual": Things requiring human action — obtaining API keys from external services, purchasing subscriptions, manual account setup`;
}

function buildGenericPrompt(
  nodeType: string,
  config: Record<string, unknown>,
  context: WorkflowContext
): string {
  return `You are a Claude Code configuration expert. Analyze this ${nodeType} node configuration and suggest optimal settings.

## Current Configuration
\`\`\`json
${JSON.stringify(config, null, 2)}
\`\`\`

## Workflow Context
- Workflow: "${context.workflowName}"
- Connected to: ${context.connectedNodes.map((n) => `${n.label} (${n.type})`).join(', ') || 'none'}

## Analysis Instructions
Review all configuration fields. Suggest improvements for completeness, clarity, and best practices.

IMPORTANT: The "suggestions" array MUST include EVERY configurable field from the config — not just fields you want to change.
- For fields that need changes: set suggestedValue to your recommended value, priority to "high", "medium", or "low".
- For fields that are already optimal: set suggestedValue EQUAL to currentValue and priority to "none".

Respond in this EXACT JSON format (no markdown fences, just raw JSON):
{
  "summary": "One sentence overall assessment",
  "overallScore": 7,
  "suggestions": [
    {
      "field": "fieldName",
      "currentValue": "current value or null",
      "suggestedValue": "suggested or same value",
      "reason": "Why this is good as-is / Why this change improves it",
      "priority": "high|medium|low|none"
    }
  ],
  "missingRequirements": [
    {
      "type": "config_field",
      "description": "What is missing (if anything)",
      "solution": "How to fix it",
      "category": "auto_fixable or manual"
    }
  ]
}

IMPORTANT for missingRequirements category (include only if there ARE missing requirements):
- "auto_fixable": Things an AI agent can do — create directories, create config files, add env var placeholders to .env, write boilerplate code
- "manual": Things requiring human action — obtaining API keys from external services, purchasing subscriptions, manual account setup`;
}

// ---------------------------------------------------------------------------
// Per-Node AI Analysis (Streaming)
// ---------------------------------------------------------------------------

export async function analyzeNodeConfig(
  node: AnalysisNode,
  workflowContext: WorkflowContext,
  onChunk: (text: string) => void
): Promise<ConfigSuggestion> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  }

  const client = new Anthropic({ apiKey });
  const maskedConfig = maskSecrets(node.config || {});
  const nodeType = (node.type || '').toUpperCase();

  // Build type-specific prompt
  let prompt: string;
  switch (nodeType) {
    case 'AGENT':
      prompt = buildAgentPrompt(maskedConfig, workflowContext);
      break;
    case 'MCP_SERVER':
      prompt = buildMcpPrompt(maskedConfig, workflowContext);
      break;
    case 'HOOK':
      prompt = buildHookPrompt(maskedConfig, workflowContext);
      break;
    default:
      prompt = buildGenericPrompt(nodeType, maskedConfig, workflowContext);
  }

  // Use Opus for best analysis; fall back to Sonnet if needed
  let model = 'claude-opus-4-6';
  let usedFallback = false;

  const buildSuggestion = (parseResult: ParseResult, suffix?: string): ConfigSuggestion => {
    const parsed = parseResult.data;
    let summary = parsed.summary || 'Analysis complete';
    if (!parseResult.success) summary = 'Failed to parse AI response';
    if (suffix) summary += ` ${suffix}`;

    return {
      nodeId: node.id,
      nodeType: node.type,
      nodeLabel: node.label,
      summary,
      overallScore: parsed.overallScore || 5,
      suggestions: (parsed.suggestions || []).map((s: LlmSuggestionResponse) => ({
        field: s.field,
        currentValue: s.currentValue,
        suggestedValue: s.suggestedValue,
        reason: s.reason,
        priority: s.priority || 'medium',
      })),
      missingRequirements: (parsed.missingRequirements || []).map((r: LlmRequirementResponse) => ({
        type: r.type || 'config_field',
        description: r.description,
        solution: r.solution,
        nodeId: node.id,
        nodeLabel: node.label,
        category: r.category || 'manual',
      })),
      _parseFailed: !parseResult.success,
    } as ConfigSuggestion;
  };

  try {
    const stream = client.messages.stream({
      model,
      max_tokens: 8192,
      temperature: 0.2,
      system: 'You are an expert AI agent configuration advisor. Always respond with valid JSON only. No markdown fences, no extra text before or after the JSON.',
      messages: [{ role: 'user', content: prompt }],
    });

    let fullText = '';
    stream.on('text', (text) => {
      fullText += text;
      onChunk(text);
    });

    await stream.finalMessage();

    // Parse JSON from response
    const parseResult = parseJsonResponse(fullText);
    return buildSuggestion(parseResult);
  } catch (err: unknown) {
    // If Opus fails with overload, try Sonnet
    if (!usedFallback && err instanceof Anthropic.APIError && err.status === 529) {
      usedFallback = true;
      model = 'claude-sonnet-4-5-20250929';
      onChunk('\n[Falling back to Sonnet model...]\n');

      const stream = client.messages.stream({
        model,
        max_tokens: 8192,
        temperature: 0.2,
        system: 'You are an expert AI agent configuration advisor. Always respond with valid JSON only. No markdown fences, no extra text before or after the JSON.',
        messages: [{ role: 'user', content: prompt }],
      });

      let fullText = '';
      stream.on('text', (text) => {
        fullText += text;
        onChunk(text);
      });

      await stream.finalMessage();
      const parseResult = parseJsonResponse(fullText);
      return buildSuggestion(parseResult, '(analyzed with Sonnet)');
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// JSON Parsing Helper
// ---------------------------------------------------------------------------

interface ParseResult {
  success: boolean;
  data: LlmAnalysisResponse;
}

function parseJsonResponse(text: string): ParseResult {
  const trimmed = text.trim();

  // Strategy 1: Direct parse
  try {
    return { success: true, data: JSON.parse(trimmed) };
  } catch {
    // continue
  }

  // Strategy 2: Extract from markdown fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      return { success: true, data: JSON.parse(fenceMatch[1].trim()) };
    } catch {
      // continue
    }
  }

  // Strategy 3: First { to last }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return { success: true, data: JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) };
    } catch {
      // continue — might be truncated
    }
  }

  // Strategy 4: Repair truncated JSON
  // The AI response was likely cut off mid-stream. Try to close unclosed
  // brackets/braces to salvage partial data.
  if (firstBrace !== -1) {
    const repaired = repairTruncatedJson(trimmed.slice(firstBrace));
    if (repaired) {
      try {
        return { success: true, data: JSON.parse(repaired) };
      } catch {
        // continue
      }
    }
  }

  // All strategies failed
  return {
    success: false,
    data: {
      summary: 'Failed to parse AI response',
      overallScore: 5,
      suggestions: [],
      missingRequirements: [],
    },
  };
}

/**
 * Attempt to repair truncated JSON by closing unclosed brackets and braces.
 * Handles cases where the AI response was cut off mid-stream.
 */
function repairTruncatedJson(text: string): string | null {
  // Strip any trailing incomplete string (cut off mid-value)
  let cleaned = text;

  // If the last non-whitespace char is inside a string, try to close it
  const lastQuoteIdx = cleaned.lastIndexOf('"');
  if (lastQuoteIdx !== -1) {
    // Count unescaped quotes to see if we're inside a string
    let quoteCount = 0;
    for (let i = 0; i <= lastQuoteIdx; i++) {
      if (cleaned[i] === '"' && (i === 0 || cleaned[i - 1] !== '\\')) {
        quoteCount++;
      }
    }
    // Odd number of quotes means we're inside an unclosed string
    if (quoteCount % 2 !== 0) {
      cleaned = cleaned.slice(0, lastQuoteIdx + 1);
    }
  }

  // Remove trailing comma or colon (incomplete key-value pair)
  cleaned = cleaned.replace(/[,:\s]+$/, '');

  // Count unclosed brackets and braces
  const stack: string[] = [];
  let inString = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '"' && (i === 0 || cleaned[i - 1] !== '\\')) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) {
        stack.pop();
      }
    }
  }

  if (stack.length === 0) return null; // Nothing to repair

  // Close all unclosed brackets/braces in reverse order
  const closing = stack.reverse().join('');
  return cleaned + closing;
}

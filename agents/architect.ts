// =============================================================================
// Architect Agent
// Generates ExecutionPlans from user intent using Claude Opus
// =============================================================================
// Uses smartGenerate for multi-workspace failover (A → B → B strategy)
// =============================================================================

import { v4 as uuidv4 } from 'uuid';
import {
  ExecutionPlan,
  ExecutionStep,
  PlanContext,
  PlanMetadata,
} from '../types/execution-plan';
import { emitSessionMessage } from '../socket/emitter';
import { SessionMessage } from '../shared/socket-events';
import { smartGenerate } from '../lib/anthropic-client';
import { PlanGenerationError } from '../types/errors';

// -----------------------------------------------------------------------------
// System Prompt for Architect
// -----------------------------------------------------------------------------

const ARCHITECT_SYSTEM_PROMPT = `You are an expert software architect AI assistant. Your role is to analyze user requests for building AI agent workflows and generate detailed execution plans.

You will receive:
1. A user's intent/request describing what they want to build
2. The current canvas state (existing nodes and edges)

You must output a valid JSON ExecutionPlan that can be executed by the Builder agent.

## ExecutionPlan Schema

\`\`\`typescript
interface ExecutionPlan {
  id: string;                    // UUID
  version: '1.0';
  metadata: {
    name: string;                // Short descriptive name
    description: string;         // What this plan accomplishes
    complexity: 'simple' | 'moderate' | 'complex';
    estimatedSteps: number;
  };
  context: {
    userIntent: string;          // Original user request
    existingNodes: Array<{ id, type, label }>;
    existingEdges: Array<{ id, source, target }>;
  };
  steps: ExecutionStep[];
}

interface ExecutionStep {
  id: string;                    // UUID
  order: number;                 // Execution order (1-based)
  name: string;                  // Human-readable step name
  description?: string;          // What this step does
  action: ExecutionAction;       // The action to perform
  dependsOn: string[];           // Step IDs that must complete first
  output?: {
    nodeIdVariable?: string;     // Variable name to store created node ID
    edgeIdVariable?: string;     // Variable name to store created edge ID
    filePathVariable?: string;   // Variable name to store file path
  };
}

// Action Types:
type ExecutionAction =
  | CreateNodeAction
  | ConnectNodesAction
  | UpdateNodeAction
  | DeleteNodeAction
  | CreateFileAction
  | RegisterCapabilityAction;

interface CreateNodeAction {
  type: 'CREATE_NODE';
  nodeType: string;              // 'agent', 'skill', 'department', 'agent-pool', 'hook', 'command', 'mcp-server'
  label: string;
  parentId?: string;             // Use \${variable_name} for references
  position?: { x: number; y: number };
  config?: Record<string, unknown>;
}

interface ConnectNodesAction {
  type: 'CONNECT_NODES';
  sourceId: string;              // Use \${variable_name} for references
  targetId: string;              // Use \${variable_name} for references
  edgeType?: 'data' | 'control' | 'event' | 'delegation' | 'failover';
}

interface UpdateNodeAction {
  type: 'UPDATE_NODE';
  nodeId: string;                // Use \${variable_name} for references
  changes: {
    label?: string;
    config?: Record<string, unknown>;
  };
}

interface DeleteNodeAction {
  type: 'DELETE_NODE';
  nodeId: string;                // Use \${variable_name} for references
}

interface CreateFileAction {
  type: 'CREATE_FILE';
  path: string;                  // Relative to sandbox (e.g., 'agents/supervisor.md')
  content: string;
}

interface RegisterCapabilityAction {
  type: 'REGISTER_CAPABILITY';
  name: string;
  capabilityType: 'skill' | 'hook' | 'command';
  content: string;
  triggers?: string[];
}
\`\`\`

## Variable References

Use \${variable_name} syntax to reference outputs from previous steps:
- If step 1 creates a node and stores it as "supervisor_id", step 2 can reference it as \${supervisor_id}
- Always ensure dependencies are correct (steps referencing variables must depend on the step that creates them)

## CRITICAL: Agent Config Requirements

When creating AGENT nodes, you MUST provide a rich config object so the agent is fully configured and ready to run. Include ALL of these fields:

\`\`\`json
{
  "role": "specialist|leader|orchestrator|executor|auditor|monitor|planner",
  "model": "claude-sonnet-4-20250514 or claude-opus-4-20250514 (use opus for directors/orchestrators)",
  "provider": "anthropic",
  "temperature": 0.3-0.9 (lower for analytical, higher for creative),
  "description": "One sentence describing what this agent does and its domain expertise",
  "systemPrompt": "Detailed 3-5 sentence system prompt describing the agent's role, responsibilities, input/output expectations, and collaboration patterns"
}
\`\`\`

**systemPrompt** is the most important field. Write a substantive, domain-specific prompt that:
- Describes the agent's specialty and expertise area
- Lists 3-5 specific responsibilities
- Describes what inputs it receives and what outputs it produces
- Mentions which other agents it collaborates with

For HOOK nodes, include: event, command, matcher, description.
For SKILL nodes, include: description, whenToUse, content.
For MCP_SERVER nodes, include: command, args, description.

## Guidelines

1. **Analyze the Request**: Understand what the user wants to build
2. **Plan the Structure**: Determine what nodes, connections, and files are needed
3. **Order Dependencies**: Steps must be ordered so dependencies complete first
4. **Use Variables**: Store created IDs in variables for later reference
5. **Be Specific**: Include all necessary configuration in node configs — ALWAYS include role, model, description, and systemPrompt for agents
6. **Create Files**: Generate corresponding configuration files in sandbox
7. **CRITICAL - Connect Capabilities**: When creating capability nodes (SKILL, HOOK, COMMAND, MCP_SERVER):
   - ALWAYS generate a CONNECT_NODES step immediately after creation
   - Link the capability to the Agent or Pool that uses it
   - Use edgeType: 'data' for skills/tools, 'event' for hooks
   - Example: After creating "Terraform Skill", add: { type: 'CONNECT_NODES', sourceId: '\${infra_agent_id}', targetId: '\${terraform_skill_id}', edgeType: 'data' }
   - NEVER leave Skills, Hooks, or MCP Servers floating without connections
8. **CONNECT TO PEOPLE, NOT PLACES**:
   - NEVER connect edges directly to a DEPARTMENT or AGENT_POOL container node
   - ALWAYS connect to the Lead Agent or specific Agent INSIDE that container
   - Example: Director → DevOps Lead Agent (CORRECT), NOT Director → DevOps Department (WRONG)
   - When creating hierarchies, first create the container, then the Lead Agent inside it, then connect to the Lead Agent
9. **USE SEMANTIC EDGE TYPES**:
   - 'delegation': Manager/Director → Subordinate/Lead (renders as Orange solid line)
   - 'data': Data pipeline / information exchange between agents (renders as Blue solid line)
   - 'control': Sequential workflow steps (renders as Green solid line)
   - 'event': Hook/Alert → Agent notifications (renders as Purple solid line)
   - 'failover': Backup/fallback connections (renders as Red dashed line)
   - ALWAYS specify edgeType in CONNECT_NODES actions for proper visualization

## Example Output

For a request like "Create a supervisor agent that delegates to two worker agents":

\`\`\`json
{
  "id": "plan-123",
  "version": "1.0",
  "metadata": {
    "name": "Supervisor-Worker Architecture",
    "description": "Creates a supervisor agent with two worker agents and delegation connections",
    "complexity": "moderate",
    "estimatedSteps": 5
  },
  "context": {
    "userIntent": "Create a supervisor agent that delegates to two worker agents",
    "existingNodes": [],
    "existingEdges": []
  },
  "steps": [
    {
      "id": "step-1",
      "order": 1,
      "name": "Create Supervisor Agent",
      "action": {
        "type": "CREATE_NODE",
        "nodeType": "agent",
        "label": "Supervisor",
        "config": {
          "role": "orchestrator",
          "model": "claude-opus-4-20250514",
          "provider": "anthropic",
          "temperature": 0.5,
          "description": "Top-level orchestrator that routes tasks to worker agents and monitors completion",
          "systemPrompt": "You are the Supervisor, the top-level orchestrator for this workflow. Your responsibilities:\\n- Route incoming tasks to the appropriate Worker agent\\n- Monitor task completion and handle failures\\n- Aggregate results from workers and report status\\n- Escalate issues that workers cannot resolve\\nYou receive raw task requests and produce final consolidated outputs."
        }
      },
      "dependsOn": [],
      "output": { "nodeIdVariable": "supervisor_id" }
    },
    {
      "id": "step-2",
      "order": 2,
      "name": "Create Worker Agent 1",
      "action": {
        "type": "CREATE_NODE",
        "nodeType": "agent",
        "label": "Worker 1",
        "config": {
          "role": "executor",
          "model": "claude-sonnet-4-20250514",
          "provider": "anthropic",
          "temperature": 0.7,
          "description": "General-purpose executor that handles delegated tasks from the Supervisor",
          "systemPrompt": "You are Worker 1, a general-purpose executor agent. Your responsibilities:\\n- Execute tasks delegated by the Supervisor\\n- Report progress and results back to the Supervisor\\n- Flag blockers or ambiguities before proceeding\\n- Collaborate with Worker 2 when tasks overlap\\nYou receive structured task assignments and produce completed deliverables."
        }
      },
      "dependsOn": [],
      "output": { "nodeIdVariable": "worker1_id" }
    },
    {
      "id": "step-3",
      "order": 3,
      "name": "Create Worker Agent 2",
      "action": {
        "type": "CREATE_NODE",
        "nodeType": "agent",
        "label": "Worker 2",
        "config": {
          "role": "executor",
          "model": "claude-sonnet-4-20250514",
          "provider": "anthropic",
          "temperature": 0.7,
          "description": "General-purpose executor that handles delegated tasks from the Supervisor",
          "systemPrompt": "You are Worker 2, a general-purpose executor agent. Your responsibilities:\\n- Execute tasks delegated by the Supervisor\\n- Report progress and results back to the Supervisor\\n- Flag blockers or ambiguities before proceeding\\n- Collaborate with Worker 1 when tasks overlap\\nYou receive structured task assignments and produce completed deliverables."
        }
      },
      "dependsOn": [],
      "output": { "nodeIdVariable": "worker2_id" }
    },
    {
      "id": "step-4",
      "order": 4,
      "name": "Connect Supervisor to Worker 1",
      "action": {
        "type": "CONNECT_NODES",
        "sourceId": "\${supervisor_id}",
        "targetId": "\${worker1_id}",
        "edgeType": "delegation"
      },
      "dependsOn": ["step-1", "step-2"]
    },
    {
      "id": "step-5",
      "order": 5,
      "name": "Connect Supervisor to Worker 2",
      "action": {
        "type": "CONNECT_NODES",
        "sourceId": "\${supervisor_id}",
        "targetId": "\${worker2_id}",
        "edgeType": "delegation"
      },
      "dependsOn": ["step-1", "step-3"]
    }
  ]
}
\`\`\`

IMPORTANT: Output ONLY valid JSON. No markdown code blocks, no explanation text. Just the raw JSON object.`;

// -----------------------------------------------------------------------------
// Architect Agent Class
// -----------------------------------------------------------------------------

export class ArchitectAgent {
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    // Client initialization now handled by smartGenerate with multi-workspace failover
  }

  // ---------------------------------------------------------------------------
  // Generate execution plan from user intent
  // ---------------------------------------------------------------------------

  async generatePlan(
    userIntent: string,
    context: PlanContext
  ): Promise<ExecutionPlan | null> {
    this.emitMessage('architect', `Analyzing request: "${userIntent}"`);

    try {
      // Build the user message with context
      const userMessage = this.buildUserMessage(userIntent, context);

      // Call Claude Opus via smartGenerate (with multi-workspace failover)
      const response = await smartGenerate('ARCHITECT', ARCHITECT_SYSTEM_PROMPT, [
        {
          role: 'user',
          content: userMessage,
        },
      ]);

      // Extract text content
      const textContent = response.content.find((c) => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        this.emitMessage('architect', 'Failed to generate plan: no text response');
        return null;
      }

      // Parse JSON
      const plan = this.parseAndValidatePlan(textContent.text, userIntent, context);

      if (plan) {
        this.emitMessage(
          'architect',
          `Generated plan "${plan.metadata.name}" with ${plan.steps.length} steps.`
        );
      }

      return plan;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.emitMessage('architect', `Failed to generate plan: ${errorMessage}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Build user message with context
  // ---------------------------------------------------------------------------

  private buildUserMessage(userIntent: string, context: PlanContext): string {
    return `## User Request
${userIntent}

## Current Canvas State

### Existing Nodes (${context.existingNodes.length})
${
  context.existingNodes.length > 0
    ? JSON.stringify(context.existingNodes, null, 2)
    : 'None - canvas is empty'
}

### Existing Edges (${context.existingEdges.length})
${
  context.existingEdges.length > 0
    ? JSON.stringify(context.existingEdges, null, 2)
    : 'None - no connections'
}

## Instructions
Generate an ExecutionPlan to fulfill this request. Consider the existing canvas state and build upon it if relevant. Output ONLY valid JSON.`;
  }

  // ---------------------------------------------------------------------------
  // Parse and validate the plan
  // ---------------------------------------------------------------------------

  private parseAndValidatePlan(
    jsonText: string,
    userIntent: string,
    context: PlanContext
  ): ExecutionPlan | null {
    try {
      // Try to extract JSON from the response (handle potential markdown wrapping)
      let cleanJson = jsonText.trim();

      // Remove markdown code blocks if present
      if (cleanJson.startsWith('```')) {
        const lines = cleanJson.split('\n');
        // Remove first line (```json or ```)
        lines.shift();
        // Remove last line (```)
        if (lines[lines.length - 1]?.trim() === '```') {
          lines.pop();
        }
        cleanJson = lines.join('\n');
      }

      const parsed = JSON.parse(cleanJson);

      // Validate required fields
      if (!parsed.metadata || !parsed.steps || !Array.isArray(parsed.steps)) {
        this.emitMessage('architect', 'Invalid plan structure: missing metadata or steps');
        return null;
      }

      // Ensure plan has an ID
      if (!parsed.id) {
        parsed.id = uuidv4();
      }

      // Ensure version
      parsed.version = '1.0';

      // Ensure context is set
      parsed.context = {
        userIntent,
        existingNodes: context.existingNodes,
        existingEdges: context.existingEdges,
      };

      // Validate steps
      const validationErrors = this.validateSteps(parsed.steps);
      if (validationErrors.length > 0) {
        parsed.validationErrors = validationErrors;
        parsed.validated = false;
        this.emitMessage(
          'architect',
          `Plan has validation warnings: ${validationErrors.join(', ')}`
        );
      } else {
        parsed.validated = true;
      }

      return parsed as ExecutionPlan;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.emitMessage('architect', `Failed to parse plan JSON: ${errorMessage}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Validate steps
  // ---------------------------------------------------------------------------

  private validateSteps(steps: ExecutionStep[]): string[] {
    const errors: string[] = [];
    const stepIds = new Set(steps.map((s) => s.id));
    const outputVariables = new Set<string>();

    for (const step of steps) {
      // Check step has required fields
      if (!step.id) {
        errors.push(`Step missing id`);
      }
      if (!step.action) {
        errors.push(`Step ${step.id} missing action`);
      }

      // Check dependencies reference valid steps
      for (const depId of step.dependsOn || []) {
        if (!stepIds.has(depId)) {
          errors.push(`Step ${step.id} depends on unknown step ${depId}`);
        }
      }

      // Track output variables
      if (step.output?.nodeIdVariable) {
        outputVariables.add(step.output.nodeIdVariable);
      }
      if (step.output?.edgeIdVariable) {
        outputVariables.add(step.output.edgeIdVariable);
      }
      if (step.output?.filePathVariable) {
        outputVariables.add(step.output.filePathVariable);
      }
    }

    // Check variable references
    for (const step of steps) {
      const actionJson = JSON.stringify(step.action);
      const varRefs = actionJson.match(/\$\{(\w+)\}/g) || [];

      for (const ref of varRefs) {
        const varName = ref.slice(2, -1); // Remove ${ and }

        // Check if variable is defined by a previous step
        const definingStep = steps.find(
          (s) =>
            s.output?.nodeIdVariable === varName ||
            s.output?.edgeIdVariable === varName ||
            s.output?.filePathVariable === varName
        );

        if (!definingStep) {
          errors.push(`Step ${step.id} references undefined variable ${varName}`);
        } else if (
          !step.dependsOn?.includes(definingStep.id) &&
          definingStep.order >= step.order
        ) {
          errors.push(
            `Step ${step.id} references ${varName} but doesn't depend on step ${definingStep.id}`
          );
        }
      }
    }

    return errors;
  }

  // ---------------------------------------------------------------------------
  // Helper methods
  // ---------------------------------------------------------------------------

  private emitMessage(role: SessionMessage['role'], content: string): void {
    emitSessionMessage({
      sessionId: this.sessionId,
      message: {
        id: uuidv4(),
        role,
        content,
        timestamp: Date.now(),
      },
    });
  }
}

// -----------------------------------------------------------------------------
// Factory function
// -----------------------------------------------------------------------------

export function createArchitectAgent(sessionId: string): ArchitectAgent {
  return new ArchitectAgent(sessionId);
}

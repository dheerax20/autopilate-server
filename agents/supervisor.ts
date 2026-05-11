// =============================================================================
// Supervisor Agent
// Routes user intents using Gemini 2.0 Flash for fast classification
// =============================================================================

import { GoogleGenerativeAI } from '@google/generative-ai';
import { v4 as uuidv4 } from 'uuid';
import { DetectedIntent, IntentType, Session } from '../types/session';
import { PlanContext } from '../types/execution-plan';
import { emitSessionMessage, emitSessionStateChange } from '../socket/emitter';
import { SessionMessage, SessionState } from '../shared/socket-events';
import { createArchitectAgent } from './architect';
import { createBuilderAgent, BuilderAgent } from './builder';
import { canvas_get_state } from '../mcp/canvas';
import { IntentClassificationError } from '../types/errors';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const SUPERVISOR_MODEL = 'gemini-2.0-flash';

// -----------------------------------------------------------------------------
// Intent Classification Prompt
// -----------------------------------------------------------------------------

const INTENT_CLASSIFICATION_PROMPT = `You are an intent classifier for an AI agent workflow builder application.

Classify the user's message into one of these intent types:
- BUILD: User wants to create new agents, workflows, departments, or any new components
- EDIT: User wants to modify, update, or change existing components on the canvas
- QUERY: User is asking a question about the system, capabilities, or existing components
- EXPORT: User wants to export, download, or save their workflow
- CONFIGURE: User wants to change settings or configuration
- UNKNOWN: Cannot determine intent

Also extract any relevant entities:
- nodeTypes: Types of nodes mentioned (agent, skill, department, etc.)
- nodeNames: Specific names of nodes or components
- actions: Verbs or actions mentioned (create, add, connect, delete, etc.)

Respond in JSON format ONLY:
{
  "type": "BUILD|EDIT|QUERY|EXPORT|CONFIGURE|UNKNOWN",
  "confidence": 0.0-1.0,
  "entities": {
    "nodeTypes": ["string"],
    "nodeNames": ["string"],
    "actions": ["string"]
  },
  "rawIntent": "brief summary of what user wants"
}`;

// -----------------------------------------------------------------------------
// Supervisor Agent Class
// -----------------------------------------------------------------------------

export class SupervisorAgent {
  private genAI: GoogleGenerativeAI | null = null;
  private sessionId: string;
  private builderAgent: BuilderAgent | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;

    // Initialize Google AI client
    const apiKey = process.env.GOOGLE_API_KEY;
    if (apiKey) {
      this.genAI = new GoogleGenerativeAI(apiKey);
    } else {
      console.warn('[Supervisor] GOOGLE_API_KEY not set - using fallback intent detection');
    }
  }

  // ---------------------------------------------------------------------------
  // Process user message and route appropriately
  // ---------------------------------------------------------------------------

  async processMessage(
    message: string,
    session: Session
  ): Promise<void> {
    // Update session state to routing
    this.emitStateChange('routing', session.state);

    this.emitMessage('supervisor', 'Analyzing your request...');

    try {
      // Detect intent
      const intent = await this.detectIntent(message);

      this.emitMessage(
        'supervisor',
        `Detected intent: ${intent.type} (${Math.round(intent.confidence * 100)}% confidence)`
      );

      // Route based on intent
      switch (intent.type) {
        case 'BUILD':
        case 'EDIT':
          await this.handleBuildOrEdit(message, intent, session);
          break;

        case 'QUERY':
          await this.handleQuery(message, intent, session);
          break;

        case 'EXPORT':
          await this.handleExport(intent, session);
          break;

        case 'CONFIGURE':
          await this.handleConfigure(message, intent, session);
          break;

        default:
          this.emitMessage(
            'supervisor',
            "I'm not sure what you'd like me to do. Try asking me to:\n" +
              '- Build an agent workflow (e.g., "Create a supervisor with two workers")\n' +
              '- Modify existing nodes (e.g., "Change the model for Agent 1")\n' +
              '- Export your workflow (e.g., "Export as JSON")\n' +
              '- Ask questions (e.g., "What agents are on the canvas?")'
          );
          this.emitStateChange('idle', 'routing');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.emitMessage('supervisor', `Error processing request: ${errorMessage}`);
      this.emitStateChange('error', 'routing');
    }
  }

  // ---------------------------------------------------------------------------
  // Detect intent from user message
  // ---------------------------------------------------------------------------

  private async detectIntent(message: string): Promise<DetectedIntent> {
    // Try Gemini-based classification first
    if (this.genAI) {
      try {
        const model = this.genAI.getGenerativeModel({ model: SUPERVISOR_MODEL });

        const result = await model.generateContent([
          INTENT_CLASSIFICATION_PROMPT,
          `User message: "${message}"`,
        ]);

        const response = result.response.text();

        // Parse JSON response — safely extract and validate
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
          const validTypes: IntentType[] = ['BUILD', 'EDIT', 'QUERY', 'EXPORT', 'CONFIGURE', 'UNKNOWN'];
          const parsedType = typeof parsed.type === 'string' ? parsed.type.toUpperCase() : 'UNKNOWN';

          return {
            type: validTypes.includes(parsedType as IntentType)
              ? (parsedType as IntentType)
              : 'UNKNOWN',
            confidence: typeof parsed.confidence === 'number'
              ? Math.max(0, Math.min(1, parsed.confidence))
              : 0.8,
            entities: parsed.entities as DetectedIntent['entities'],
            rawIntent: typeof parsed.rawIntent === 'string' ? parsed.rawIntent : message,
          };
        }
      } catch (error) {
        console.warn(
          '[Supervisor] Gemini classification failed, using fallback:',
          error instanceof Error ? error.message : error
        );
      }
    }

    // Fallback: keyword-based classification
    return this.fallbackIntentDetection(message);
  }

  // ---------------------------------------------------------------------------
  // Fallback intent detection using keywords
  // ---------------------------------------------------------------------------

  private fallbackIntentDetection(message: string): DetectedIntent {
    const lowerMessage = message.toLowerCase();

    // Build intent keywords
    const buildKeywords = [
      'create', 'build', 'add', 'make', 'new', 'generate', 'setup', 'design',
      'construct', 'implement', 'deploy'
    ];

    // Edit intent keywords
    const editKeywords = [
      'change', 'modify', 'update', 'edit', 'rename', 'move', 'delete', 'remove',
      'configure', 'adjust', 'fix', 'connect', 'disconnect', 'link'
    ];

    // Query intent keywords
    const queryKeywords = [
      'what', 'how', 'why', 'which', 'where', 'when', 'who', 'show', 'list',
      'display', 'explain', 'describe', 'tell me', '?'
    ];

    // Export intent keywords
    const exportKeywords = [
      'export', 'download', 'save', 'output', 'generate file', 'get json',
      'get yaml', 'get markdown'
    ];

    // Configure intent keywords
    const configureKeywords = [
      'setting', 'settings', 'preference', 'config', 'configuration', 'option'
    ];

    // Count matches
    const counts = {
      BUILD: buildKeywords.filter((k) => lowerMessage.includes(k)).length,
      EDIT: editKeywords.filter((k) => lowerMessage.includes(k)).length,
      QUERY: queryKeywords.filter((k) => lowerMessage.includes(k)).length,
      EXPORT: exportKeywords.filter((k) => lowerMessage.includes(k)).length,
      CONFIGURE: configureKeywords.filter((k) => lowerMessage.includes(k)).length,
    };

    // Find highest count
    let maxType: IntentType = 'UNKNOWN';
    let maxCount = 0;

    for (const [type, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        maxType = type as IntentType;
      }
    }

    // Extract node types mentioned
    const nodeTypes: string[] = [];
    const nodeTypeKeywords = ['agent', 'skill', 'department', 'pool', 'hook', 'command', 'mcp', 'workflow'];
    for (const keyword of nodeTypeKeywords) {
      if (lowerMessage.includes(keyword)) {
        nodeTypes.push(keyword);
      }
    }

    return {
      type: maxCount > 0 ? maxType : 'UNKNOWN',
      confidence: maxCount > 0 ? Math.min(0.6 + maxCount * 0.1, 0.9) : 0.3,
      entities: {
        nodeTypes: nodeTypes.length > 0 ? nodeTypes : undefined,
        actions: buildKeywords.filter((k) => lowerMessage.includes(k)),
      },
      rawIntent: message,
    };
  }

  // ---------------------------------------------------------------------------
  // Handle BUILD or EDIT intent
  // ---------------------------------------------------------------------------

  private async handleBuildOrEdit(
    message: string,
    intent: DetectedIntent,
    session: Session
  ): Promise<void> {
    // Update state to planning
    this.emitStateChange('planning', 'routing');

    // Get current canvas state for context
    const canvasResult = canvas_get_state();
    const context: PlanContext = {
      userIntent: message,
      existingNodes: canvasResult.success && canvasResult.data
        ? canvasResult.data.nodes.map((n) => ({
            id: n.id,
            type: n.type,
            label: n.label,
          }))
        : [],
      existingEdges: canvasResult.success && canvasResult.data
        ? canvasResult.data.edges.map((e) => ({
            id: e.id,
            source: e.sourceId,
            target: e.targetId,
          }))
        : [],
    };

    // Create Architect agent to generate plan
    const architect = createArchitectAgent(this.sessionId);
    const plan = await architect.generatePlan(message, context);

    if (!plan) {
      this.emitMessage('supervisor', 'Failed to generate execution plan. Please try rephrasing your request.');
      this.emitStateChange('idle', 'planning');
      return;
    }

    // Update state to executing
    this.emitStateChange('executing', 'planning');

    // Create Builder agent to execute plan
    this.builderAgent = createBuilderAgent(this.sessionId);
    const result = await this.builderAgent.executePlan(plan);

    // Final state update
    if (result.status === 'completed') {
      this.emitStateChange('completed', 'executing');
      this.emitMessage('supervisor', 'Your workflow has been created successfully!');
    } else if (result.status === 'paused') {
      this.emitMessage('supervisor', 'Execution paused. Resume when ready.');
    } else {
      this.emitStateChange('error', 'executing');
      this.emitMessage('supervisor', 'Execution encountered errors. Check the steps above for details.');
    }

    // Reset to idle after a moment
    setTimeout(() => {
      this.emitStateChange('idle', result.status === 'completed' ? 'completed' : 'error');
    }, 2000);
  }

  // ---------------------------------------------------------------------------
  // Handle QUERY intent
  // ---------------------------------------------------------------------------

  private async handleQuery(
    message: string,
    intent: DetectedIntent,
    session: Session
  ): Promise<void> {
    // Get canvas state
    const canvasResult = canvas_get_state();

    if (!canvasResult.success || !canvasResult.data) {
      this.emitMessage('supervisor', 'Unable to read canvas state.');
      this.emitStateChange('idle', 'routing');
      return;
    }

    const { nodes, edges } = canvasResult.data;

    // Generate response based on query
    let response = '';

    if (message.toLowerCase().includes('canvas') || message.toLowerCase().includes('what')) {
      if (nodes.length === 0) {
        response = 'The canvas is currently empty. Try asking me to create something like "Create a supervisor agent with two workers".';
      } else {
        response = `**Canvas Summary**\n\n`;
        response += `**Nodes (${nodes.length}):**\n`;
        for (const node of nodes) {
          response += `- ${node.label} (${node.type})${node.parentId ? ' [nested]' : ''}\n`;
        }
        response += `\n**Connections (${edges.length}):**\n`;
        for (const edge of edges) {
          const sourceNode = nodes.find((n) => n.id === edge.sourceId);
          const targetNode = nodes.find((n) => n.id === edge.targetId);
          response += `- ${sourceNode?.label || edge.sourceId} → ${targetNode?.label || edge.targetId}${edge.edgeType ? ` (${edge.edgeType})` : ''}\n`;
        }
      }
    } else {
      response = 'I can help you with:\n' +
        '- Building new agent workflows\n' +
        '- Modifying existing components\n' +
        '- Exporting your workflow\n' +
        '- Answering questions about the canvas\n\n' +
        'Try: "What\'s on the canvas?" or "Create a new agent called Researcher"';
    }

    this.emitMessage('supervisor', response);
    this.emitStateChange('idle', 'routing');
  }

  // ---------------------------------------------------------------------------
  // Handle EXPORT intent
  // ---------------------------------------------------------------------------

  private async handleExport(
    intent: DetectedIntent,
    session: Session
  ): Promise<void> {
    // Get canvas state
    const canvasResult = canvas_get_state();

    if (!canvasResult.success || !canvasResult.data) {
      this.emitMessage('supervisor', 'Unable to read canvas state for export.');
      this.emitStateChange('idle', 'routing');
      return;
    }

    const { nodes, edges } = canvasResult.data;

    if (nodes.length === 0) {
      this.emitMessage('supervisor', 'Nothing to export - the canvas is empty.');
      this.emitStateChange('idle', 'routing');
      return;
    }

    // For now, just describe what would be exported
    // Full export functionality uses the existing export system
    this.emitMessage(
      'supervisor',
      `Ready to export workflow with ${nodes.length} nodes and ${edges.length} connections.\n\n` +
      'Use the **Export** button in the toolbar to:\n' +
      '- Export as JSON (workflow configuration)\n' +
      '- Export as Markdown (agent documentation)\n\n' +
      'Or ask me to "generate configuration files" to create them in the sandbox.'
    );

    this.emitStateChange('idle', 'routing');
  }

  // ---------------------------------------------------------------------------
  // Handle CONFIGURE intent
  // ---------------------------------------------------------------------------

  private async handleConfigure(
    message: string,
    intent: DetectedIntent,
    session: Session
  ): Promise<void> {
    this.emitMessage(
      'supervisor',
      'Configuration changes should be made through the Properties Panel on the right side of the screen.\n\n' +
      'Select a node on the canvas, then use the panel to configure:\n' +
      '- Model settings\n' +
      '- Permissions\n' +
      '- Tools and skills\n' +
      '- And more!'
    );

    this.emitStateChange('idle', 'routing');
  }

  // ---------------------------------------------------------------------------
  // Pause/Resume control (delegated to builder)
  // ---------------------------------------------------------------------------

  pause(): void {
    this.builderAgent?.pause();
  }

  resume(): void {
    this.builderAgent?.resume();
  }

  // ---------------------------------------------------------------------------
  // Helper methods
  // ---------------------------------------------------------------------------

  private emitStateChange(newState: SessionState, previousState: SessionState): void {
    emitSessionStateChange({
      sessionId: this.sessionId,
      state: newState,
      previousState,
    });
  }

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

export function createSupervisorAgent(sessionId: string): SupervisorAgent {
  return new SupervisorAgent(sessionId);
}

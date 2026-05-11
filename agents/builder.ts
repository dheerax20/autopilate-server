// =============================================================================
// Builder Agent
// Executes ExecutionPlans using MCP tools with Claude Code / Sonnet
// =============================================================================
// Uses smartGenerate for multi-workspace failover (A → B → B strategy)
// =============================================================================

import Anthropic from '@anthropic-ai/sdk';
import {
  ExecutionPlan,
  ExecutionStep,
  ExecutionAction,
  PlanExecutionState,
  StepResult,
  resolveActionVariables,
  CreateNodeAction,
  ConnectNodesAction,
  UpdateNodeAction,
  DeleteNodeAction,
  CreateFileAction,
  RegisterCapabilityAction,
} from '../types/execution-plan';
import {
  emitExecutionStepStart,
  emitExecutionStepComplete,
  emitPlanComplete,
  emitSessionMessage,
} from '../socket/emitter';
import { SessionMessage } from '../shared/socket-events';
import { v4 as uuidv4 } from 'uuid';

// Canvas MCP tools
import {
  canvas_create_node,
  canvas_connect_nodes,
  canvas_update_property,
  canvas_delete_node,
  CANVAS_TOOLS,
} from '../mcp/canvas';

// Sandbox MCP tools
import {
  sandbox_create_file,
  SANDBOX_TOOLS,
} from '../mcp/sandbox-mcp';
import { smartGenerate } from '../lib/anthropic-client';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// -----------------------------------------------------------------------------
// Builder Agent Class
// -----------------------------------------------------------------------------

export class BuilderAgent {
  private sessionId: string;
  private executionState: PlanExecutionState | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    // Client initialization now handled by smartGenerate with multi-workspace failover
  }

  // ---------------------------------------------------------------------------
  // Execute a complete plan
  // ---------------------------------------------------------------------------

  async executePlan(plan: ExecutionPlan): Promise<PlanExecutionState> {
    // Initialize execution state
    this.executionState = {
      planId: plan.id,
      status: 'executing',
      currentStepIndex: 0,
      stepResults: [],
      variables: {},
      startedAt: Date.now(),
    };

    // Emit plan start message
    this.emitMessage(
      'builder',
      `Starting execution of plan "${plan.metadata.name}" with ${plan.steps.length} steps.`
    );

    try {
      // Execute steps in order (respecting dependencies)
      for (let i = 0; i < plan.steps.length; i++) {
        // Check if paused
        if (this.executionState.status === 'paused') {
          this.emitMessage('builder', 'Execution paused.');
          break;
        }

        const step = plan.steps[i];
        this.executionState.currentStepIndex = i;

        // Check dependencies are complete
        const depsComplete = this.checkDependencies(step, plan.steps);
        if (!depsComplete) {
          this.emitMessage('builder', `Skipping step "${step.name}" - dependencies not met.`);
          continue;
        }

        // Emit step start
        emitExecutionStepStart({
          sessionId: this.sessionId,
          planId: plan.id,
          stepId: step.id,
          stepName: step.name,
          stepOrder: step.order,
          totalSteps: plan.steps.length,
        });

        // Execute the step
        const result = await this.executeStep(step);

        // Store result
        this.executionState.stepResults.push(result);

        // Store output variables
        if (result.success && step.output) {
          if (step.output.nodeIdVariable && result.result?.nodeId) {
            this.executionState.variables[step.output.nodeIdVariable] = result.result.nodeId;
          }
          if (step.output.edgeIdVariable && result.result?.edgeId) {
            this.executionState.variables[step.output.edgeIdVariable] = result.result.edgeId;
          }
          if (step.output.filePathVariable && result.result?.filePath) {
            this.executionState.variables[step.output.filePathVariable] = result.result.filePath;
          }
        }

        // Emit step complete
        emitExecutionStepComplete({
          sessionId: this.sessionId,
          planId: plan.id,
          stepId: step.id,
          stepName: step.name,
          stepOrder: step.order,
          totalSteps: plan.steps.length,
          success: result.success,
          result: result.result,
          error: result.error,
          createdNodeId: result.result?.nodeId,
          createdEdgeId: result.result?.edgeId,
        });

        // Handle failure
        if (!result.success) {
          this.executionState.status = 'failed';
          this.emitMessage('builder', `Step "${step.name}" failed: ${result.error}`);
          break;
        }

        this.emitMessage('builder', `Completed step ${i + 1}/${plan.steps.length}: ${step.name}`);
      }

      // Mark complete if not failed/paused
      if (this.executionState.status === 'executing') {
        this.executionState.status = 'completed';
        this.executionState.completedAt = Date.now();
      }

      // Emit plan complete
      emitPlanComplete(
        this.sessionId,
        plan.id,
        this.executionState.status === 'completed'
      );

      this.emitMessage(
        'builder',
        this.executionState.status === 'completed'
          ? `Plan "${plan.metadata.name}" completed successfully!`
          : `Plan "${plan.metadata.name}" ${this.executionState.status}.`
      );

      return this.executionState;
    } catch (error) {
      this.executionState.status = 'failed';
      this.executionState.completedAt = Date.now();

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.emitMessage('builder', `Plan execution failed: ${errorMessage}`);

      emitPlanComplete(this.sessionId, plan.id, false);

      return this.executionState;
    }
  }

  // ---------------------------------------------------------------------------
  // Execute a single step
  // ---------------------------------------------------------------------------

  private async executeStep(step: ExecutionStep): Promise<StepResult> {
    const startedAt = Date.now();
    const retryCount = step.retryCount || MAX_RETRIES;
    const retryDelay = step.retryDelayMs || RETRY_DELAY_MS;

    let lastError: string | undefined;

    for (let attempt = 0; attempt < retryCount; attempt++) {
      try {
        // Resolve variables in action
        const resolvedAction = resolveActionVariables(
          step.action,
          this.executionState!.variables
        );

        // Execute based on action type
        const result = await this.executeAction(resolvedAction);

        if (result.success) {
          return {
            stepId: step.id,
            success: true,
            startedAt,
            completedAt: Date.now(),
            result: result.data,
          };
        }

        lastError = result.error;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error';
      }

      // Wait before retry
      if (attempt < retryCount - 1) {
        await this.sleep(retryDelay);
      }
    }

    return {
      stepId: step.id,
      success: false,
      startedAt,
      completedAt: Date.now(),
      error: lastError,
    };
  }

  // ---------------------------------------------------------------------------
  // Execute an action
  // ---------------------------------------------------------------------------

  private async executeAction(
    action: ExecutionAction
  ): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> {
    switch (action.type) {
      case 'CREATE_NODE': {
        const nodeAction = action as CreateNodeAction;
        const result = canvas_create_node({
          type: nodeAction.nodeType,
          label: nodeAction.label,
          parentId: nodeAction.parentId,
          position: nodeAction.position,
          config: nodeAction.config as Record<string, unknown>,
        });
        return {
          success: result.success,
          data: result.data ? { nodeId: result.data.nodeId } : undefined,
          error: result.error,
        };
      }

      case 'CONNECT_NODES': {
        const connectAction = action as ConnectNodesAction;
        const result = canvas_connect_nodes({
          sourceId: connectAction.sourceId,
          targetId: connectAction.targetId,
          // Phase 6: edgeType now required, default to 'data' if not specified
          edgeType: connectAction.edgeType || 'data',
        });
        return {
          success: result.success,
          data: result.data ? { edgeId: result.data.edgeId } : undefined,
          error: result.error,
        };
      }

      case 'UPDATE_NODE': {
        const updateAction = action as UpdateNodeAction;
        // Update each changed property
        if (updateAction.changes.label) {
          const labelResult = canvas_update_property({
            nodeId: updateAction.nodeId,
            propertyPath: 'label',
            value: updateAction.changes.label,
          });
          if (!labelResult.success) {
            return { success: false, error: labelResult.error };
          }
        }
        if (updateAction.changes.config) {
          for (const [key, value] of Object.entries(updateAction.changes.config)) {
            const configResult = canvas_update_property({
              nodeId: updateAction.nodeId,
              propertyPath: key,
              value,
            });
            if (!configResult.success) {
              return { success: false, error: configResult.error };
            }
          }
        }
        return { success: true };
      }

      case 'DELETE_NODE': {
        const deleteAction = action as DeleteNodeAction;
        const result = canvas_delete_node({ nodeId: deleteAction.nodeId });
        return { success: result.success, error: result.error };
      }

      case 'CREATE_FILE': {
        const fileAction = action as CreateFileAction;
        const result = await sandbox_create_file({
          path: fileAction.path,
          content: fileAction.content,
        });
        return {
          success: result.success,
          data: result.data ? { filePath: fileAction.path } : undefined,
          error: result.error,
        };
      }

      case 'REGISTER_CAPABILITY': {
        const capAction = action as RegisterCapabilityAction;
        // Write capability file to appropriate location
        const capPath = this.getCapabilityPath(capAction);
        const result = await sandbox_create_file({
          path: capPath,
          content: capAction.content,
        });
        return {
          success: result.success,
          data: result.data ? { filePath: capPath } : undefined,
          error: result.error,
        };
      }

      default: {
        const unknownAction = action as { type: string };
        return {
          success: false,
          error: `Unknown action type: ${unknownAction.type}`,
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helper methods
  // ---------------------------------------------------------------------------

  private checkDependencies(step: ExecutionStep, allSteps: ExecutionStep[]): boolean {
    if (!step.dependsOn || step.dependsOn.length === 0) {
      return true;
    }

    for (const depId of step.dependsOn) {
      const depResult = this.executionState!.stepResults.find((r) => r.stepId === depId);
      if (!depResult || !depResult.success) {
        return false;
      }
    }

    return true;
  }

  private getCapabilityPath(action: RegisterCapabilityAction): string {
    const ext = action.capabilityType === 'hook' ? '.json' : '.md';
    const dir = `.claude/${action.capabilityType}s`;
    return `${dir}/${action.name}${ext}`;
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // Pause/Resume control
  // ---------------------------------------------------------------------------

  pause(): void {
    if (this.executionState && this.executionState.status === 'executing') {
      this.executionState.status = 'paused';
    }
  }

  resume(): void {
    if (this.executionState && this.executionState.status === 'paused') {
      this.executionState.status = 'executing';
    }
  }

  // ---------------------------------------------------------------------------
  // Get tool definitions for Claude API
  // ---------------------------------------------------------------------------

  static getToolDefinitions(): Anthropic.Tool[] {
    const tools: Anthropic.Tool[] = [];

    // Add canvas tools
    for (const tool of Object.values(CANVAS_TOOLS)) {
      tools.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters as Anthropic.Tool['input_schema'],
      });
    }

    // Add sandbox tools
    for (const tool of Object.values(SANDBOX_TOOLS)) {
      tools.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters as Anthropic.Tool['input_schema'],
      });
    }

    return tools;
  }
}

// -----------------------------------------------------------------------------
// Factory function
// -----------------------------------------------------------------------------

export function createBuilderAgent(sessionId: string): BuilderAgent {
  return new BuilderAgent(sessionId);
}

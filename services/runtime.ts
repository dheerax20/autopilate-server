// =============================================================================
// Runtime Service
// Phase 6: Validates and simulates agent system execution
// =============================================================================

import { emitExecutionLog } from '../socket/emitter';

interface NodeInfo {
  id: string;
  type: string;
  label: string;
}

interface EdgeInfo {
  id: string;
  sourceId: string;
  targetId: string;
  edgeType?: string;
}

interface RuntimeValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate the agent system graph
 */
export function validateSystem(
  nodes: NodeInfo[],
  edges: EdgeInfo[]
): RuntimeValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for empty canvas
  if (nodes.length === 0) {
    errors.push('No nodes on canvas. Add agents to build a system.');
    return { valid: false, errors, warnings };
  }

  // Check for agents with no connections
  const connectedNodes = new Set<string>();
  edges.forEach((e) => {
    connectedNodes.add(e.sourceId);
    connectedNodes.add(e.targetId);
  });

  const orphanAgents = nodes.filter(
    (n) => n.type === 'AGENT' && !connectedNodes.has(n.id)
  );
  if (orphanAgents.length > 0) {
    warnings.push(
      `${orphanAgents.length} agent(s) have no connections: ${orphanAgents
        .map((a) => a.label)
        .join(', ')}`
    );
  }

  // Check for untyped edges (grey dashed)
  const untypedEdges = edges.filter(
    (e) => !e.edgeType || e.edgeType === 'default' || e.edgeType === 'smoothstep'
  );
  if (untypedEdges.length > 0) {
    warnings.push(
      `${untypedEdges.length} edge(s) have no semantic type (grey dashed). Consider assigning types.`
    );
  }

  // Check for cycles (basic detection)
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(nodeId: string): boolean {
    visited.add(nodeId);
    recursionStack.add(nodeId);

    const outgoing = edges.filter((e) => e.sourceId === nodeId);
    for (const edge of outgoing) {
      if (!visited.has(edge.targetId)) {
        if (hasCycle(edge.targetId)) return true;
      } else if (recursionStack.has(edge.targetId)) {
        return true;
      }
    }

    recursionStack.delete(nodeId);
    return false;
  }

  for (const node of nodes) {
    if (!visited.has(node.id) && hasCycle(node.id)) {
      warnings.push('Circular dependency detected in agent graph.');
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Helper function for delays
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simulate system startup sequence
 */
export async function simulateSystemStart(
  sessionId: string,
  nodes: NodeInfo[],
  edges: EdgeInfo[]
): Promise<void> {
  const log = (msg: string, stream: 'stdout' | 'stderr' = 'stdout') => {
    emitExecutionLog(sessionId, msg, stream);
  };

  log('='.repeat(60));
  log('VISUAL AGENT BUILDER - Runtime Simulation');
  log('='.repeat(60));
  log('');

  // Phase 1: Validation
  log('[PHASE 1/4] Validating system graph...');
  await delay(300);

  const validation = validateSystem(nodes, edges);

  if (validation.errors.length > 0) {
    validation.errors.forEach((err) => log(`ERROR: ${err}`, 'stderr'));
    log('');
    log('System validation failed. Fix errors before running.', 'stderr');
    return;
  }

  validation.warnings.forEach((warn) => log(`WARN: ${warn}`));
  log(`Validation complete: ${nodes.length} nodes, ${edges.length} edges`);
  log('');

  // Phase 2: Initialize MCP servers
  const mcpServers = nodes.filter((n) => n.type === 'MCP_SERVER' || n.type === 'mcpServerNode');
  log(`[PHASE 2/4] Initializing ${mcpServers.length} MCP server(s)...`);
  for (const mcp of mcpServers) {
    await delay(200);
    log(`  > ${mcp.label} connected`);
  }
  if (mcpServers.length === 0) {
    log('  (No MCP servers found)');
  }
  log('');

  // Phase 3: Initialize departments and pools
  const departments = nodes.filter((n) => n.type === 'DEPARTMENT' || n.type === 'departmentNode');
  const pools = nodes.filter((n) => n.type === 'AGENT_POOL' || n.type === 'agentPoolNode');

  if (departments.length > 0 || pools.length > 0) {
    log(`[PHASE 3/4] Initializing ${departments.length} department(s), ${pools.length} pool(s)...`);
    for (const dept of departments) {
      await delay(150);
      log(`  > Department: ${dept.label} mounted`);
    }
    for (const pool of pools) {
      await delay(100);
      log(`  > Pool: ${pool.label} ready`);
    }
    log('');
  }

  // Phase 4: Initialize agents
  const agents = nodes.filter((n) => n.type === 'AGENT' || n.type === 'customNode');
  log(`[PHASE 4/4] Initializing ${agents.length} agent(s)...`);
  for (const agent of agents) {
    await delay(150);
    log(`  > Agent: ${agent.label} ready`);
  }
  log('');

  // Wire connections
  log(`[WIRING] Establishing ${edges.length} connection(s)...`);
  for (const edge of edges) {
    const source = nodes.find((n) => n.id === edge.sourceId);
    const target = nodes.find((n) => n.id === edge.targetId);
    await delay(80);
    const edgeTypeLabel = edge.edgeType && edge.edgeType !== 'smoothstep'
      ? edge.edgeType.toUpperCase()
      : 'DEFAULT';
    log(
      `  > ${source?.label || edge.sourceId} --> ${target?.label || edge.targetId} [${edgeTypeLabel}]`
    );
  }
  log('');

  log('='.repeat(60));
  log('> System initialized successfully!');
  log(`> Ready with ${agents.length} agent(s), ${edges.length} connection(s)`);
  log('='.repeat(60));
}

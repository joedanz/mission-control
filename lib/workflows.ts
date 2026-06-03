// ABOUTME: Pure workflow-graph logic — the single source of truth for validation + traversal, shared by
// ABOUTME: the mc CLI, the daemon walker, and (later) the React Flow canvas's isValidConnection. No DB, no
// ABOUTME: spawn, no fs (mirrors lib/profiles.ts + daemon/render-profile.ts), so it's unit-testable alone.

import { assertEnum, ValidationError } from './validation';
import { extractRefs } from './workflow-refs';
import {
  WORKFLOW_STATUSES,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_TRIGGERS,
  WORKFLOW_STEP_STATUSES,
  WORKFLOW_NODE_TYPES,
  WORKFLOW_ON_ERROR,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowStatus,
  type WorkflowRunStatus,
  type WorkflowTrigger,
  type WorkflowStepStatus,
  type WorkflowNodeType,
  type WorkflowOnError,
  type AgentNodeData,
} from './db/schema';

// ── Enum guards (narrow + agent-actionable error, via the shared assertEnum) ───────────
export const assertWorkflowStatus = (v: string): WorkflowStatus => assertEnum(v, WORKFLOW_STATUSES, 'status');
export const assertWorkflowRunStatus = (v: string): WorkflowRunStatus => assertEnum(v, WORKFLOW_RUN_STATUSES, 'runStatus');
export const assertWorkflowTrigger = (v: string): WorkflowTrigger => assertEnum(v, WORKFLOW_TRIGGERS, 'trigger');
export const assertWorkflowStepStatus = (v: string): WorkflowStepStatus => assertEnum(v, WORKFLOW_STEP_STATUSES, 'stepStatus');
export const assertWorkflowNodeType = (v: string): WorkflowNodeType => assertEnum(v, WORKFLOW_NODE_TYPES, 'node.type');
export const assertWorkflowOnError = (v: string): WorkflowOnError => assertEnum(v, WORKFLOW_ON_ERROR, 'node.data.onError');

// ── Traversal ──────────────────────────────────────────────────────────────────────
export function nodeById(graph: WorkflowGraph, id: string): WorkflowNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

/** Target nodes of edges leaving `nodeId` (in edge order). */
export function outgoers(graph: WorkflowGraph, nodeId: string): WorkflowNode[] {
  return graph.edges
    .filter((e) => e.source === nodeId)
    .map((e) => nodeById(graph, e.target))
    .filter((n): n is WorkflowNode => n !== undefined);
}

/** Source nodes of edges entering `nodeId` (in edge order). */
export function incomers(graph: WorkflowGraph, nodeId: string): WorkflowNode[] {
  return graph.edges
    .filter((e) => e.target === nodeId)
    .map((e) => nodeById(graph, e.source))
    .filter((n): n is WorkflowNode => n !== undefined);
}

export function triggerNodes(graph: WorkflowGraph): WorkflowNode[] {
  return graph.nodes.filter((n) => n.type === 'trigger');
}

/** Every node with a directed edge-path INTO `nodeId` (its transitive predecessors). Reverse BFS over
 *  `incomers`. Used to gate {{nodeId.field}} data-passing refs: a reference is only valid from an ancestor
 *  (data flows along wired edges), so this is the single source of truth for that check (CLI + canvas). */
export function ancestors(graph: WorkflowGraph, nodeId: string): Set<string> {
  const seen = new Set<string>();
  const stack = incomers(graph, nodeId).map((n) => n.id);
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const up of incomers(graph, id)) stack.push(up.id);
  }
  return seen;
}

/** The single entry (trigger) node. Assumes a validated graph (validateGraph enforces exactly one). */
export function entryNode(graph: WorkflowGraph): WorkflowNode {
  const triggers = triggerNodes(graph);
  if (triggers.length !== 1) {
    throw new ValidationError('graph', `a workflow needs exactly one trigger node (found ${triggers.length})`);
  }
  return triggers[0];
}

/** DFS cycle check over edges among existing nodes (white/grey/black coloring; a grey re-visit = back edge). */
export function hasCycle(graph: WorkflowGraph): boolean {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>(graph.nodes.map((n) => [n.id, WHITE]));
  const visit = (id: string): boolean => {
    color.set(id, GREY);
    for (const next of outgoers(graph, id)) {
      const c = color.get(next.id);
      if (c === GREY) return true;
      if (c === WHITE && visit(next.id)) return true;
    }
    color.set(id, BLACK);
    return false;
  };
  for (const n of graph.nodes) {
    if (color.get(n.id) === WHITE && visit(n.id)) return true;
  }
  return false;
}

/** Kahn topological order (parents before children). Throws ValidationError on a cycle. Ties broken by
 *  node declaration order so the result is deterministic. */
export function topoOrder(graph: WorkflowGraph): string[] {
  const indegree = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges) {
    if (indegree.has(e.target)) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  }
  // Seed the queue in node-declaration order so equal-rank nodes come out deterministically.
  const queue = graph.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift() as string;
    order.push(id);
    for (const next of outgoers(graph, id)) {
      const d = (indegree.get(next.id) ?? 0) - 1;
      indegree.set(next.id, d);
      if (d === 0) queue.push(next.id);
    }
  }
  if (order.length !== graph.nodes.length) {
    throw new ValidationError('graph', 'the workflow graph has a cycle');
  }
  return order;
}

// ── Validation (the gate run by the CLI before a run, and the canvas later) ───────────
/** Throw ValidationError on the first structural problem; return void when the graph is runnable.
 *  Checks: non-empty, unique ids, known node types, edges reference existing nodes, acyclic (DAG),
 *  exactly one trigger node, every agent node carries a non-blank prompt + valid onError, and every
 *  {{nodeId.field}} data-passing ref points at an existing ancestor (data flows along wired edges). */
export function validateGraph(graph: WorkflowGraph): void {
  if (!graph.nodes.length) throw new ValidationError('graph', 'a workflow has no nodes');

  const seen = new Set<string>();
  for (const n of graph.nodes) {
    if (seen.has(n.id)) throw new ValidationError('nodes', `duplicate node id "${n.id}"`);
    seen.add(n.id);
    assertWorkflowNodeType(n.type); // unknown type → ValidationError
  }

  for (const e of graph.edges) {
    if (!seen.has(e.source)) throw new ValidationError('edges', `edge "${e.id}" has an unknown source "${e.source}"`);
    if (!seen.has(e.target)) throw new ValidationError('edges', `edge "${e.id}" has an unknown target "${e.target}"`);
  }

  if (hasCycle(graph)) throw new ValidationError('graph', 'the workflow graph has a cycle');

  const triggers = triggerNodes(graph);
  if (triggers.length !== 1) {
    throw new ValidationError('graph', `a workflow needs exactly one trigger node (found ${triggers.length})`);
  }

  for (const n of graph.nodes) {
    if (n.type !== 'agent') continue;
    const { prompt } = readAgentNodeData(n); // validates prompt + onError
    // Data-passing: every {{ref}} in the prompt must point at an existing ANCESTOR (an edge-backed
    // upstream node), so the visual graph and the data dependencies stay in sync. (incomers-based, so
    // it's recomputed per node — fine at authoring/run scale.)
    const anc = ancestors(graph, n.id);
    for (const ref of extractRefs(prompt)) {
      if (!seen.has(ref.nodeId)) throw new ValidationError('node.data.prompt', `agent node "${n.id}" references unknown node "${ref.nodeId}" in {{${ref.nodeId}.${ref.path}}}`);
      if (ref.nodeId === n.id) throw new ValidationError('node.data.prompt', `agent node "${n.id}" references itself in {{${ref.nodeId}.${ref.path}}}`);
      if (!anc.has(ref.nodeId)) throw new ValidationError('node.data.prompt', `agent node "${n.id}" references "${ref.nodeId}" but no edge connects it as an ancestor (data flows along edges)`);
    }
  }
}

// ── Node config reads ────────────────────────────────────────────────────────────────
/** Validate + return a type='agent' node's config. `prompt` is required (the runner can't spawn without
 *  it); profileSlug/projectSlug/responseSchema/onError are optional. Throws ValidationError on a bad shape. */
export function readAgentNodeData(node: WorkflowNode): AgentNodeData {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
  if (!prompt) throw new ValidationError('node.data.prompt', `agent node "${node.id}" is missing a prompt`);
  const out: AgentNodeData = { prompt };
  if (data.profileSlug !== undefined) out.profileSlug = String(data.profileSlug);
  if (data.projectSlug !== undefined) out.projectSlug = String(data.projectSlug);
  if (data.responseSchema !== undefined) out.responseSchema = data.responseSchema as Record<string, unknown>;
  if (data.onError !== undefined) out.onError = assertWorkflowOnError(String(data.onError)); // halt | continue
  return out;
}

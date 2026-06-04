// ABOUTME: Pure workflow-graph logic — the single source of truth for validation + traversal, shared by
// ABOUTME: the mc CLI, the daemon walker, and (later) the React Flow canvas's isValidConnection. No DB, no
// ABOUTME: spawn, no fs (mirrors lib/profiles.ts + daemon/render-profile.ts), so it's unit-testable alone.

import { assertEnum, ValidationError } from './validation';
import { extractRefs, isObject } from './workflow-refs';
import { getCatalogEntry, catalogSlugs } from './composio-catalog';
import {
  WORKFLOW_STATUSES,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_TRIGGERS,
  WORKFLOW_STEP_STATUSES,
  WORKFLOW_NODE_TYPES,
  WORKFLOW_ON_ERROR,
  BRANCH_OPS,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowStatus,
  type WorkflowRunStatus,
  type WorkflowTrigger,
  type WorkflowStepStatus,
  type WorkflowNodeType,
  type WorkflowOnError,
  type AgentNodeData,
  type IntegrationNodeData,
  type BranchNodeData,
  type BranchCase,
} from './db/schema';
import { ELSE } from './workflow-branch';

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
    // Validate the per-type config and collect the text that may carry {{nodeId.field}} data-passing refs:
    // an agent's prompt, or the JSON of an integration node's arguments (refs live inside string values).
    let refText: string | null = null;
    let field = '';
    if (n.type === 'agent') {
      refText = readAgentNodeData(n).prompt; // validates prompt + onError
      field = 'node.data.prompt';
    } else if (n.type === 'integration') {
      refText = JSON.stringify(readIntegrationNodeData(n).arguments ?? {}); // validates toolkit + action + onError
      field = 'node.data.arguments';
    } else if (n.type === 'branch') {
      refText = JSON.stringify(readBranchNodeData(n).cases); // validates cases; refs live in when.left/right
      field = 'node.data.cases';
    } else {
      continue; // trigger (and future gate) carry no refs
    }

    // Data-passing: every {{ref}} must point at an existing ANCESTOR (an edge-backed upstream node), so the
    // visual graph and the data dependencies stay in sync. Same rule for every node type (single mechanism).
    const anc = ancestors(graph, n.id);
    for (const ref of extractRefs(refText)) {
      if (!seen.has(ref.nodeId)) throw new ValidationError(field, `node "${n.id}" references unknown node "${ref.nodeId}" in {{${ref.nodeId}.${ref.path}}}`);
      if (ref.nodeId === n.id) throw new ValidationError(field, `node "${n.id}" references itself in {{${ref.nodeId}.${ref.path}}}`);
      if (!anc.has(ref.nodeId)) throw new ValidationError(field, `node "${n.id}" references "${ref.nodeId}" but no edge connects it as an ancestor (data flows along edges)`);
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

/** Validate + return a type='integration' node's config (slice 5). `toolkit` must be a known catalog slug and
 *  `action` one of that toolkit's allowed tools (so a bad action is caught at authoring, not at run time);
 *  arguments/onError are optional. Throws ValidationError (listing the valid values) on a bad shape. */
export function readIntegrationNodeData(node: WorkflowNode): IntegrationNodeData {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const toolkit = typeof data.toolkit === 'string' ? data.toolkit.trim() : '';
  if (!toolkit) throw new ValidationError('node.data.toolkit', `integration node "${node.id}" is missing a toolkit`);
  const entry = getCatalogEntry(toolkit);
  if (!entry) throw new ValidationError('node.data.toolkit', `integration node "${node.id}" has unknown toolkit "${toolkit}" (supported: ${catalogSlugs().join(', ')})`);
  const action = typeof data.action === 'string' ? data.action.trim() : '';
  if (!action) throw new ValidationError('node.data.action', `integration node "${node.id}" is missing an action`);
  if (!entry.allowedTools.includes(action)) {
    throw new ValidationError('node.data.action', `integration node "${node.id}" action "${action}" is not allowed for ${toolkit} (allowed: ${entry.allowedTools.join(', ')})`);
  }
  const out: IntegrationNodeData = { toolkit, action };
  if (data.arguments !== undefined) out.arguments = data.arguments as Record<string, unknown>;
  if (data.onError !== undefined) out.onError = assertWorkflowOnError(String(data.onError)); // halt | continue
  return out;
}

/** Validate + return a type='branch' node's config (slice 6a). At least one case; each case has a non-blank,
 *  unique name (not the reserved 'else') and a condition with a known op + a left operand. The chosen case
 *  name routes to outgoing edges by sourceHandle; left/right may carry {{nodeId.field}} refs (ancestor-checked
 *  by validateGraph). Throws ValidationError (listing valid ops) on a bad shape. */
export function readBranchNodeData(node: WorkflowNode): BranchNodeData {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const rawCases = Array.isArray(data.cases) ? data.cases : [];
  if (!rawCases.length) throw new ValidationError('node.data.cases', `branch node "${node.id}" needs at least one case`);

  const names = new Set<string>();
  const cases: BranchCase[] = rawCases.map((raw, i) => {
    const c = isObject(raw) ? raw : {};
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) throw new ValidationError('node.data.cases', `branch node "${node.id}" case #${i} is missing a name`);
    if (name === ELSE) throw new ValidationError('node.data.cases', `branch node "${node.id}" cannot name a case "${ELSE}" (it is the implicit fallback)`);
    if (names.has(name)) throw new ValidationError('node.data.cases', `branch node "${node.id}" has a duplicate case "${name}"`);
    names.add(name);
    const when = isObject(c.when) ? c.when : null;
    if (!when) throw new ValidationError('node.data.cases', `branch node "${node.id}" case "${name}" is missing a condition`);
    if (when.left === undefined) throw new ValidationError('node.data.cases', `branch node "${node.id}" case "${name}" condition is missing a left operand`);
    const op = assertEnum(typeof when.op === 'string' ? when.op : '', BRANCH_OPS, 'node.data.cases.when.op');
    return { name, when: { left: when.left, op, right: when.right } };
  });

  const out: BranchNodeData = { cases };
  if (data.onError !== undefined) out.onError = assertWorkflowOnError(String(data.onError)); // halt | continue
  return out;
}

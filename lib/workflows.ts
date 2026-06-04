// ABOUTME: Pure workflow-graph logic — the single source of truth for validation + traversal, shared by
// ABOUTME: the mc CLI, the daemon walker, and (later) the React Flow canvas's isValidConnection. No DB, no
// ABOUTME: spawn, no fs (mirrors lib/profiles.ts + daemon/render-profile.ts), so it's unit-testable alone.

import { assertEnum, ValidationError } from './validation';
import { extractRefs, isObject } from './workflow-refs';
import { getCatalogEntry, catalogSlugs } from './composio-catalog';
import { isValidCron, isValidTimezone } from './profiles';
import { SCHEDULE_MIN_INTERVAL_SEC } from './constants';
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
  type WorkflowEdge,
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
  type TriggerNodeData,
  type WorkflowSchedule,
  type WorkflowEventTrigger,
  type GateNodeData,
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

/** The nodes ready to DECIDE right now (slice 6b — concurrent scheduling): not yet `started`, with EVERY
 *  predecessor already `terminal` (completed | failed | skipped). This is the wait-all join — a merge node
 *  is decidable only once all its incoming branches have resolved (a skipped branch counts as resolved, so a
 *  not-taken branch never deadlocks the join). Pure + order-stable (graph declaration order) so the scheduler
 *  launches deterministically; reachedness (run vs skip) is decided separately, after a node is decidable. */
export function decidableNodes(graph: WorkflowGraph, terminal: Set<string>, started: Set<string>): string[] {
  return graph.nodes
    .filter((n) => !started.has(n.id) && incomers(graph, n.id).every((p) => terminal.has(p.id)))
    .map((n) => n.id);
}

/** Can a `source → target` edge be added to `graph`? The draw-time SSOT for the canvas's
 *  `isValidConnection` (slice 9b authoring), derived from the SAME primitives `validateGraph` uses
 *  (`nodeById`, `hasCycle`) — connection-level invariants only: both endpoints exist, no self-loop, the
 *  target isn't a trigger (triggers have no inputs), and the edge keeps the graph acyclic. Whole-graph
 *  rules (exactly-one-trigger, per-node config, {{ref}}-ancestor) can't run on an in-progress graph, so
 *  they stay in `validateGraph`, which the save path runs on the finished graph. */
export function canConnect(graph: WorkflowGraph, source: string, target: string): boolean {
  if (source === target) return false;
  const src = nodeById(graph, source);
  const tgt = nodeById(graph, target);
  if (!src || !tgt) return false;
  if (tgt.type === 'trigger') return false;
  const candidate: WorkflowEdge = { id: `__candidate__:${source}->${target}`, source, target };
  return !hasCycle({ nodes: graph.nodes, edges: [...graph.edges, candidate] });
}

// ── Validation (the gate run by the CLI before a run, and the canvas later) ───────────
/** Throw ValidationError on the first structural problem; return void when the graph is runnable.
 *  Checks: non-empty, unique ids, known node types, edges reference existing nodes (and none targets the
 *  trigger), acyclic (DAG), exactly one trigger node, every agent node carries a non-blank prompt + valid
 *  onError, and every {{nodeId.field}} data-passing ref points at an existing ancestor (data flows along
 *  wired edges). */
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
    // A trigger is the single entry node — nothing may point INTO it. This is the whole-graph home of the rule
    // canConnect enforces at draw time, so the canvas and `mc workflow update` agree on the same edge.
    if (nodeById(graph, e.target)?.type === 'trigger') {
      throw new ValidationError('edges', `edge "${e.id}" targets trigger "${e.target}" — a trigger has no inputs`);
    }
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
    } else if (n.type === 'trigger') {
      readTriggerNodeData(n); // validates the optional cron/interval schedule (slice 7); carries no refs
      continue;
    } else if (n.type === 'gate') {
      readGateNodeData(n); // validates the optional message + onError (slice 9a); carries no refs
      continue;
    } else {
      continue;
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

/** Validate + return a type='gate' node's config (slice 9a). No required fields — a bare gate just pauses the
 *  run for a human. `message` (if set) must be a string (shown to the approver); `onError` ∈ {halt,continue}
 *  applies when the gate is REJECTED (a rejected gate is a failed node). Throws ValidationError on a bad shape. */
export function readGateNodeData(node: WorkflowNode): GateNodeData {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const out: GateNodeData = {};
  if (data.message !== undefined) {
    if (typeof data.message !== 'string') throw new ValidationError('node.data.message', `gate node "${node.id}" message must be a string`);
    out.message = data.message;
  }
  if (data.onError !== undefined) out.onError = assertWorkflowOnError(String(data.onError)); // halt | continue
  return out;
}

/** Validate + return a type='trigger' node's config (slices 7–8). A trigger with neither `schedule` nor
 *  `event` is a manual trigger (fires only via `mc workflow run` / the canvas). A `schedule` (slice 7) must
 *  carry EXACTLY ONE of cron / intervalSec (cron parseable by croner; intervalSec an integer ≥
 *  SCHEDULE_MIN_INTERVAL_SEC — each fire is a paid run), plus an optional valid IANA timezone. An `event`
 *  (slice 8) makes the workflow fire from the HMAC-verified webhook route, with an optional event-type
 *  allowlist. A trigger carries AT MOST ONE of schedule | event. Reuses the profile scheduler's validators so
 *  a bad config is rejected at authoring (mc workflow create) rather than throwing inside the daemon/route. */
export function readTriggerNodeData(node: WorkflowNode): TriggerNodeData {
  const data = (node.data ?? {}) as Record<string, unknown>;
  if (data.schedule != null && data.event != null) {
    throw new ValidationError('node.data', `trigger node "${node.id}" carries both a schedule and an event — a trigger fires exactly one way`);
  }
  if (data.event != null) return { event: readEventTrigger(node, data.event) };
  if (data.schedule == null) return {};
  if (!isObject(data.schedule)) throw new ValidationError('node.data.schedule', `trigger node "${node.id}" has a malformed schedule`);
  const s = data.schedule;
  const hasCron = typeof s.cron === 'string' && s.cron.trim() !== '';
  const hasInterval = s.intervalSec != null;
  if (hasCron === hasInterval) {
    throw new ValidationError('node.data.schedule', `trigger node "${node.id}" schedule needs exactly one of cron or intervalSec`);
  }
  const schedule: WorkflowSchedule = {};
  if (hasCron) {
    const cron = (s.cron as string).trim();
    if (!isValidCron(cron)) throw new ValidationError('node.data.schedule.cron', `trigger node "${node.id}" has an invalid cron expression: ${cron}`);
    schedule.cron = cron;
  } else {
    const intervalSec = s.intervalSec;
    if (typeof intervalSec !== 'number' || !Number.isInteger(intervalSec) || intervalSec < SCHEDULE_MIN_INTERVAL_SEC) {
      throw new ValidationError('node.data.schedule.intervalSec', `trigger node "${node.id}" intervalSec must be an integer ≥ ${SCHEDULE_MIN_INTERVAL_SEC} (each fire is a paid run)`);
    }
    schedule.intervalSec = intervalSec;
  }
  if (s.timezone != null && s.timezone !== '') {
    const tz = String(s.timezone);
    if (!isValidTimezone(tz)) throw new ValidationError('node.data.schedule.timezone', `trigger node "${node.id}" has an invalid IANA timezone: ${tz}`);
    schedule.timezone = tz;
  }
  return { schedule };
}

/** Validate + return a trigger node's optional `event` config (slice 8). `source` (if set) is a non-blank
 *  operator label; `types` (if set) is an array of non-blank event-type strings (the webhook route's
 *  allowlist). Absent fields are simply omitted — an empty event ({}) is a valid "fire on any authenticated
 *  POST" trigger. */
function readEventTrigger(node: WorkflowNode, raw: unknown): WorkflowEventTrigger {
  if (!isObject(raw)) throw new ValidationError('node.data.event', `trigger node "${node.id}" has a malformed event config`);
  const event: WorkflowEventTrigger = {};
  if (raw.source != null && raw.source !== '') {
    if (typeof raw.source !== 'string') throw new ValidationError('node.data.event.source', `trigger node "${node.id}" event source must be a string`);
    event.source = raw.source;
  }
  if (raw.types != null) {
    if (!Array.isArray(raw.types) || raw.types.some((t) => typeof t !== 'string' || t.trim() === '')) {
      throw new ValidationError('node.data.event.types', `trigger node "${node.id}" event types must be an array of non-blank strings`);
    }
    event.types = raw.types as string[];
  }
  return event;
}

/** The entry trigger's schedule, or null for a manual (un-scheduled) trigger. The workflow-daemon reads this to
 *  decide which active workflows fire on a cadence. Assumes a validated graph (exactly one trigger node). */
export function triggerSchedule(graph: WorkflowGraph): WorkflowSchedule | null {
  return readTriggerNodeData(entryNode(graph)).schedule ?? null;
}

/** The entry trigger's event config, or null for a non-event (manual/cron) trigger. The webhook route reads
 *  this to decide whether a workflow accepts external events and to apply the optional event-type filter.
 *  Assumes a validated graph (exactly one trigger node). */
export function triggerEvent(graph: WorkflowGraph): WorkflowEventTrigger | null {
  return readTriggerNodeData(entryNode(graph)).event ?? null;
}

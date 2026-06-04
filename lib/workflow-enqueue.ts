// ABOUTME: Lib-tier (NO spawn) entry to start a workflow run — validate the graph, enforce the single-flight
// ABOUTME: guard, and create the run row. enqueueWorkflowRun creates a 'queued' run for the workflow-daemon to
// ABOUTME: claim; it touches only lib/ (validateGraph + the store), so the Vercel web route and the CLI can
// ABOUTME: import it directly WITHOUT pulling in daemon/runner's child-process machinery (the web tier never
// ABOUTME: spawns — plan correction #2). The synchronous daemon runner reuses prepareWorkflowRun for the same
// ABOUTME: validate + guard before it walks in-process.

import { getWorkflowBySlug, countPendingWorkflowRuns, createWorkflow, createWorkflowRun, updateWorkflowGraph, getStepRun, upsertStepRun } from './workflow-store';
import { validateGraph, nodeById } from './workflows';
import { NotFoundError, ConflictError, ValidationError, slugify } from './validation';
import type { Workflow, WorkflowRun, WorkflowTrigger, WorkflowGraph } from './db/schema';

// `context` (slice 8) is the trigger payload (e.g. a webhook body) persisted onto workflow_runs.context; the
// walker exposes it to the graph as {{trigger.output.*}}. Manual/cron callers omit it (context stays null).
export type EnqueueOpts = { trigger?: WorkflowTrigger; allowConcurrent?: boolean; context?: unknown };

/** Look up + validate a workflow and enforce the single-flight guard (refuse a second run while one is queued
 *  OR running — so a not-yet-claimed queued run still blocks a duplicate). Shared by the synchronous runner
 *  and enqueueWorkflowRun. Throws NotFoundError / ValidationError / ConflictError. */
export async function prepareWorkflowRun(slug: string, opts: EnqueueOpts = {}): Promise<Workflow> {
  const wf = await getWorkflowBySlug(slug);
  if (!wf) throw new NotFoundError('workflow', slug, "run 'mc workflow list' to see slugs");
  validateGraph(wf.graph); // ValidationError on a malformed graph (single source of truth)
  if (!opts.allowConcurrent && (await countPendingWorkflowRuns(wf.id)) > 0) {
    throw new ConflictError('workflow', `workflow "${slug}" already has a run queued or in progress`);
  }
  return wf;
}

/** Enqueue a workflow run for the workflow-daemon to execute (the async / web Run-button / `mc workflow run
 *  --async` path). Validates + single-flight-guards, then creates a 'queued' run and returns it — NO spawn,
 *  so the web route imports + calls it directly (the daemon owns execution). */
export async function enqueueWorkflowRun(slug: string, opts: EnqueueOpts = {}): Promise<WorkflowRun> {
  const wf = await prepareWorkflowRun(slug, opts);
  return createWorkflowRun({ workflowId: wf.id, trigger: opts.trigger ?? 'manual', graphSnapshot: wf.graph, status: 'queued', context: opts.context });
}

/** Save an edited workflow graph (slice 9b authoring) — lib-tier, NO spawn, so BOTH the web `save` route and
 *  `mc workflow update` import it (the run/gate pattern: one validate-then-persist home, not two). Validates
 *  through the SAME validateGraph SSOT the runner uses; an EMPTY graph is a valid draft (skip validation,
 *  matching `mc workflow create`). `graph` defaults to the current graph (a rename-only update). Throws
 *  NotFoundError (unknown slug) / ValidationError (a non-empty graph that doesn't validate). */
export async function saveWorkflowGraph(
  slug: string,
  opts: { graph?: WorkflowGraph; name?: string; description?: string } = {},
): Promise<Workflow> {
  const wf = await getWorkflowBySlug(slug);
  if (!wf) throw new NotFoundError('workflow', slug, "run 'mc workflow list' to see slugs");
  const graph = opts.graph ?? wf.graph;
  if (graph.nodes.length) validateGraph(graph); // empty = a valid draft (like create); a provided graph must be runnable
  const updated = await updateWorkflowGraph(slug, graph, { name: opts.name, description: opts.description });
  if (!updated) throw new NotFoundError('workflow', slug);
  return updated;
}

/** Create a workflow for a project — the SINGLE create SSOT for BOTH the web "New workflow" button (slice 9c,
 *  empty draft) AND `mc workflow create` (which may pass a `--graph`/`--slug`/`--description`). Lib-tier, NO
 *  spawn. Slugifies the name (or an explicit `slug`), rejects a collision UP FRONT so a duplicate maps to a
 *  clean ConflictError (→ 409 / exit CONFLICT) instead of a raw DB unique-violation, and validates a provided
 *  graph through the SAME validateGraph SSOT (an empty graph is a valid draft). Mirrors how `saveWorkflowGraph`
 *  unified the `update` path. Throws ValidationError (blank/slug-less name) / ConflictError (slug taken). */
export async function createDraftWorkflow(
  projectId: string,
  name: string,
  opts: { slug?: string; graph?: WorkflowGraph; description?: string } = {},
): Promise<Workflow> {
  const trimmed = name.trim();
  if (!trimmed) throw new ValidationError('name', 'a workflow name is required');
  const slug = slugify(opts.slug ?? trimmed);
  if (!slug) throw new ValidationError(opts.slug ? 'slug' : 'name', 'name must contain at least one letter or number');
  if (await getWorkflowBySlug(slug)) {
    throw new ConflictError('workflow', `a workflow with slug "${slug}" already exists (workflow slugs are global)`);
  }
  const graph = opts.graph ?? { nodes: [], edges: [] };
  if (graph.nodes.length) validateGraph(graph); // empty = a valid draft; a provided graph must be runnable
  return createWorkflow({ projectId, slug, name: trimmed, description: opts.description ?? null, graph });
}

export type GateDecision = 'approve' | 'reject';

/** Record a human approval decision on a paused run's gate step (slice 9a) — lib-tier, NO spawn, so the web
 *  route imports it directly. Takes the already-resolved + authorized `run` (the caller fetched it to check
 *  project ownership). Writes `{ decision, reason }` onto the gate step's `output` (leaving the step 'running'
 *  so the resume re-walk re-evaluates the gate, which now reads the decision: approve → complete, reject →
 *  fail). The caller then resumes — synchronously (CLI: resumeWorkflowRun) or by requeue (web/async:
 *  requeueWorkflowRun → the daemon). Throws if the run isn't paused or the node isn't an awaiting gate. */
export async function decideGate(run: WorkflowRun, nodeId: string, decision: GateDecision, reason?: string): Promise<WorkflowRun> {
  if (run.status !== 'paused') throw new ConflictError('workflowRun', `run ${run.id} is ${run.status}, not paused — nothing is awaiting approval`);

  const node = nodeById(run.graphSnapshot, nodeId);
  if (!node) throw new NotFoundError('node', nodeId, 'check the workflow graph for the gate node id');
  if (node.type !== 'gate') throw new ValidationError('nodeId', `node "${nodeId}" is a ${node.type}, not a gate`);

  const step = await getStepRun(run.id, nodeId);
  if (!step || step.status !== 'running') throw new ConflictError('gate', `gate "${nodeId}" is not awaiting approval on run ${run.id}`);

  await upsertStepRun(run.id, nodeId, { output: { kind: 'gate', decision, reason, decidedAt: new Date().toISOString() } });
  return run;
}

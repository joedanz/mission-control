// ABOUTME: The workflow graph walker (slices 1+3+5+6a+6b). A ready-set scheduler runs independent nodes
// ABOUTME: CONCURRENTLY (bounded by maxParallel): a node is decidable once all its predecessors are terminal
// ABOUTME: (wait-all join), so a fan-out's branches overlap while a merge waits for all of them. An agent node
// ABOUTME: interpolates {{nodeId.field}} refs + spawns a real run (optionally requesting structured output via
// ABOUTME: responseSchema), writing run state through the `mc` CLI (mc_agent scoping, like auto-claim/scheduler);
// ABOUTME: an integration node runs a deterministic Composio action (no LLM, no run, no spawn); a branch node
// ABOUTME: picks a case and ROUTES the walk to its chosen out-edges (nodes with no active incoming edge → `skipped`).
// ABOUTME: RUN-ONLY: an agent node links a runs row (cost/heartbeat/fleet feed/cancel come from it) — it never
// ABOUTME: creates a claimable task. A failed node halts the workflow (stop launching new nodes) unless onError='continue'.
// ABOUTME: Slice 4 split create from walk: runWorkflow (sync, born 'running') and enqueueWorkflowRun (born
// ABOUTME: 'queued', no spawn — the web Run button + `--async`) both create a run; walkWorkflowRun executes an
// ABOUTME: existing run and is shared by the sync path and the workflow-daemon (which claims queued runs).

import { randomUUID } from 'node:crypto';
import { mc, spawnExecutor, monitorAndFinalize, type Log } from './runner';
import { MissingSkillError } from './render-profile';
import {
  getWorkflowById,
  getWorkflowRun,
  createWorkflowRun,
  setWorkflowRunStatus,
  claimPausedWorkflowRun,
  touchWorkflowRun,
  upsertStepRun,
  setStepRunStatus,
  listStepRuns,
  getStepRun,
} from '../lib/workflow-store';
import { prepareWorkflowRun } from '../lib/workflow-enqueue';
import { decidableNodes, nodeById, readAgentNodeData, readIntegrationNodeData, readBranchNodeData, readGateNodeData } from '../lib/workflows';
import { chooseBranch } from '../lib/workflow-branch';
import { normalizeStepOutput, interpolate, interpolateValue, isObject, type RefView } from '../lib/workflow-refs';
import { getProjectById, getProfileBySlug, resolveProfile } from '../lib/queries';
import { getConnection } from '../lib/composio-store';
import { executeAction } from '../lib/composio-api';
import { ConflictError, NotFoundError, ValidationError } from '../lib/validation';
import type { Project, WorkflowGraph, WorkflowNode, WorkflowOnError, WorkflowRun, WorkflowRunStatus, WorkflowStepRun, WorkflowTrigger } from '../lib/db/schema';

const DEFAULT_TIMEOUT_SEC = 900;
const DEFAULT_GRACE_SEC = 15;
const DEFAULT_PERMISSION_MODE = 'acceptEdits'; // agent nodes need write access; null-profile path uses this
const AGENT_LABEL = 'workflow-runner';
const DEFAULT_MAX_PARALLEL = 4; // cap on concurrently in-flight nodes (agent spawns are the expensive ones)
// The walker bumps the run's heartbeat at the top of each scheduler tick, but a tick then BLOCKS in
// `Promise.race(inflight)` until a node finishes — and an agent node may run up to DEFAULT_TIMEOUT_SEC.
// Without an independent beat, any node longer than RUN_STALE_THRESHOLD_SEC (120s) lets the reaper falsely
// fail a live walk, which (via the count-based single-flight guard) lets a duplicate paid run enqueue.
// A timer decoupled from node completion keeps the run live regardless of how long the current node takes.
const WORKFLOW_HEARTBEAT_TICK_MS = 30_000;

export type RunWorkflowOpts = {
  trigger?: WorkflowTrigger;
  timeoutSec?: number;
  graceSec?: number;
  basePermissionMode?: string;
  allowConcurrent?: boolean; // bypass the single-flight guard
  maxParallel?: number; // max concurrently in-flight nodes (default DEFAULT_MAX_PARALLEL)
  log?: Log;
};

export type RunWorkflowResult = {
  workflowRunId: string;
  status: WorkflowRunStatus;
  steps: WorkflowStepRun[];
};

/** Parse the claude `--output-format json` result line (type='result', carries `.result` text + cost/usage),
 *  or null for the exec runtime / MC_DAEMON_EXEC stub / non-claude output. Stored whole into step output so
 *  slice 3's data-passing (`<nodeId.field>`) is additive — no second touch of the spawn path. */
function parseClaudeResult(stdout: string): Record<string, unknown> | null {
  let result: Record<string, unknown> | null = null;
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (o.type === 'result' || typeof o.total_cost_usd === 'number') result = o;
    } catch {
      /* not a JSON object line — skip */
    }
  }
  return result;
}

// ── Branch routing (slice 6a) ─────────────────────────────────────────────────────────
/** The handle an edge leaves its source on — sourceHandle (React Flow's native port id), falling back to a
 *  human label. A branch routes to the edges whose handle equals its chosen case name. */
const edgeHandle = (e: { sourceHandle?: string | null; label?: string }): string => e.sourceHandle ?? e.label ?? '';

/** The out-edge ids an executed node ROUTES to: a normal node activates ALL its out-edges; a branch only the
 *  edges on its chosen handle (none → that path is never reached). The walker adds these to `selectedEdges`. */
function activeOutEdges(graph: WorkflowGraph, node: WorkflowNode, chosen?: string): string[] {
  const out = graph.edges.filter((e) => e.source === node.id);
  if (node.type !== 'branch') return out.map((e) => e.id);
  return out.filter((e) => edgeHandle(e) === chosen).map((e) => e.id);
}

/** Whether any edge into `nodeId` has been routed (selected) by an upstream node — the gate for a node to run. */
const hasActiveIncomer = (graph: WorkflowGraph, nodeId: string, selected: Set<string>): boolean =>
  graph.edges.some((e) => e.target === nodeId && selected.has(e.id));

/** The case a completed branch step routed to (stored as `output.chosen`), so a resume re-derives its route
 *  without re-evaluating. undefined for a non-branch step (activeOutEdges ignores it there). */
const branchChoice = (output: unknown): string | undefined => {
  const chosen = isObject(output) ? output.chosen : undefined;
  return typeof chosen === 'string' ? chosen : undefined;
};

/** Run a workflow SYNCHRONOUSLY (the slice-1 CLI default): the calling process owns the walk, so the run is
 *  born 'running' — the workflow-daemon only ever lists/claims 'queued' runs, so a manual `mc workflow run`
 *  and a live daemon never race the same row. Keep prompts short; durable async = enqueueWorkflowRun (lib) +
 *  the daemon. Same return shape as before, so every existing e2e test is unchanged. */
export async function runWorkflow(slug: string, opts: RunWorkflowOpts = {}): Promise<RunWorkflowResult> {
  const wf = await prepareWorkflowRun(slug, opts); // shared validate + single-flight guard (lib-tier)
  const log = opts.log ?? (() => {});
  const run = await createWorkflowRun({ workflowId: wf.id, trigger: opts.trigger ?? 'manual', graphSnapshot: wf.graph, status: 'running' });
  log(`workflow ${slug} run ${run.id.slice(0, 8)} started (${wf.graph.nodes.length} nodes)`);
  return walkWorkflowRun(run, opts);
}

/** Walk an EXISTING, already-'running' workflow_run to completion. Self-contained — resolves the workflow's
 *  slug + home project from the run row — so the sync path (runWorkflow) and the workflow-daemon (after it
 *  claims a queued run) call it identically. Resumable: seeds the data-passing/skip `views` from completed
 *  steps, so a re-walk skips done nodes and refs still resolve across a resume. */
export async function walkWorkflowRun(run: WorkflowRun, opts: RunWorkflowOpts = {}): Promise<RunWorkflowResult> {
  const log = opts.log ?? (() => {});
  const wf = await getWorkflowById(run.workflowId);
  const slug = wf?.slug ?? run.workflowId; // FK guarantees wf; fall back to the id for a defensive log label
  const home = wf ? await getProjectById(wf.projectId) : null;
  if (!home) {
    await setWorkflowRunStatus(run.id, 'failed');
    throw new NotFoundError('project', wf?.projectId ?? run.workflowId, "the workflow's home project was deleted");
  }

  const snapshot = run.graphSnapshot; // pinned at create — a mid-run edit to workflows.graph can't corrupt it
  const trigger = run.trigger as WorkflowTrigger;

  // Run substrate. `views` = the {{nodeId.field}} data-passing map; `selectedEdges` = the branch-routing set
  // (the edges an executed node routed to — a normal node routes ALL its out-edges, a branch only its chosen
  // handle); `terminal` = nodes that reached a final state (completed | failed | skipped); `started` guards
  // against launching a node twice. A node is DECIDABLE only when all its predecessors are terminal (wait-all
  // join). Seed all four from completed steps so a resume skips done nodes, refs resolve, and a branch's route
  // re-derives from its stored `chosen`. (Only completed steps seed — a prior failed/skipped/running step is
  // re-decided on resume, matching the pre-6b behavior.)
  const views = new Map<string, RefView>();
  const selectedEdges = new Set<string>();
  const terminal = new Set<string>();
  const started = new Set<string>();
  const awaiting = new Set<string>(); // gate nodes pending a human decision (slice 9a) — non-terminal, block successors
  const activate = (node: WorkflowNode, chosen?: string) => {
    for (const id of activeOutEdges(snapshot, node, chosen)) selectedEdges.add(id);
  };
  for (const s of await listStepRuns(run.id)) {
    if (s.status !== 'completed') continue;
    views.set(s.nodeId, normalizeStepOutput(s.output));
    terminal.add(s.nodeId);
    started.add(s.nodeId);
    const n = nodeById(snapshot, s.nodeId);
    if (n) activate(n, branchChoice(s.output));
  }

  // Execute ONE node to its terminal result. The per-node bodies are unchanged from the sequential walker —
  // only the orchestration around them became concurrent. A branch returns `chosen` (which routes its edges).
  const executeNode = async (node: WorkflowNode): Promise<NodeResult & { chosen?: string }> => {
    if (node.type === 'trigger') {
      // Expose the trigger payload (e.g. a webhook body in run.context, slice 8) to the graph: stored under
      // `data`, normalizeStepOutput projects it into the `output` ref-root, so {{trigger.output.issue.title}}
      // resolves via the SAME path an integration step uses (no ref-resolver change). Manual/cron → undefined.
      const output = { trigger, data: run.context ?? undefined };
      await upsertStepRun(run.id, node.id, { status: 'completed', startedAt: new Date(), endedAt: new Date(), output });
      return { ok: true, output, onError: 'halt' };
    }
    if (node.type === 'branch') return runBranchNode(run.id, node, log, views); // deterministic; no run, no spawn
    if (node.type === 'agent') return runAgentNode(run.id, slug, node, home, opts, log, views); // spawns a real run
    if (node.type === 'integration') return runIntegrationNode(run.id, node, home, log, views); // Composio action
    if (node.type === 'gate') return runGateNode(run.id, node, log); // human approval — pauses the run until decided
    // trigger + agent + integration + branch + gate are all the walker executes; anything else is an honest not-yet error.
    throw new ValidationError('node.type', `node type "${node.type}" is not supported yet (the walker handles trigger + agent + integration + branch + gate)`);
  };

  let finalStatus: WorkflowRunStatus = 'completed';
  let anyFailed = false; // a node failed but onError='continue' kept the walk going → run ends 'failed'
  let halted = false;    // an onError='halt' failure: stop launching NEW nodes, let in-flight ones drain
  const maxParallel = Math.max(1, opts.maxParallel ?? DEFAULT_MAX_PARALLEL);
  const inflight = new Map<string, Promise<{ nodeId: string } & NodeResult & { chosen?: string }>>();

  // Heartbeat on a TIMER, independent of node completion — the loop below blocks in Promise.race until a
  // node finishes, so the per-tick touch alone starves during any long node. `.catch` keeps a transient DB
  // blip from becoming a process-killing unhandled rejection.
  const heartbeat = setInterval(() => { void touchWorkflowRun(run.id).catch(() => {}); }, WORKFLOW_HEARTBEAT_TICK_MS);
  try {
    // Ready-set scheduler: each tick launch every decidable+reached node (skipping the unreached instantly),
    // up to maxParallel in flight, then await the next completion and fold its result back in. Independent
    // nodes (a fan-out's branches) run concurrently; a merge waits because it isn't decidable until all its
    // branches are terminal. A sequential chain still serializes — a node's sole predecessor must finish first.
    while (true) {
      // Cancellation is checked each tick; in-flight agent nodes are independently cancelled via their runs row.
      if ((await getWorkflowRun(run.id))?.cancelRequested) { finalStatus = 'cancelled'; break; }
      await touchWorkflowRun(run.id); // liveness heartbeat for the reaper

      if (!halted) {
        // Greedy + declaration-order: decidableNodes yields in graph order, so when slots are scarce the
        // earlier-declared decidable nodes win them. Order-fair, not throughput-fair — fine for small graphs
        // (a freed slot always drains the backlog next tick; a DAG can't starve a node forever).
        for (const nodeId of decidableNodes(snapshot, terminal, started)) {
          if (inflight.size >= maxParallel) break; // slot-bound; a freed slot picks these up next tick
          const node = nodeById(snapshot, nodeId);
          started.add(nodeId);
          if (!node) { terminal.add(nodeId); continue; } // defensive: id not in graph

          // Branch routing (6a): a non-trigger node runs only if an upstream node routed an edge into it. No
          // active incoming edge (a not-taken branch path, or an all-skipped join) → record `skipped` instantly
          // (no slot, no promise); it seeds no views and routes no edges, so the skip propagates downstream.
          if (node.type !== 'trigger' && !hasActiveIncomer(snapshot, nodeId, selectedEdges)) {
            await upsertStepRun(run.id, nodeId, { status: 'skipped', startedAt: new Date(), endedAt: new Date() });
            terminal.add(nodeId);
            continue;
          }
          // Attach a no-op rejection guard at REGISTRATION (M28): a launched promise only acquires a handler
          // when it later reaches Promise.race below — but the `await upsertStepRun(...,'skipped',...)` between
          // registrations can throw under a DB blip, escaping the loop with freshly-launched promises that were
          // never raced. On Node an unhandled rejection terminates the process, killing every other in-flight
          // walk. The guard ensures a rejection is always handled; the promise itself is still raced normally.
          const p = executeNode(node).then((r) => ({ nodeId, ...r }));
          p.catch(() => {});
          inflight.set(nodeId, p);
        }
      }

      if (inflight.size === 0) break; // nothing running and nothing left to launch (or halted + drained) → done

      // Wait for the next node to finish; fold its outcome into the substrate, then re-evaluate the ready set.
      const res = await Promise.race(inflight.values());
      inflight.delete(res.nodeId);
      // A gate awaiting approval (slice 9a) is NON-terminal: it's been launched (so it won't relaunch), but it's
      // not added to `terminal`, so decidableNodes keeps its successors blocked and the walk quiesces → 'paused'.
      if (res.awaiting) { awaiting.add(res.nodeId); continue; }
      terminal.add(res.nodeId);
      const node = nodeById(snapshot, res.nodeId);
      if (res.ok) {
        views.set(res.nodeId, normalizeStepOutput(res.output));
        if (node) activate(node, res.chosen);
        continue;
      }
      anyFailed = true;
      // continue = the flow proceeds past this node: activate its out-edges so successors are still reached (a
      // successor {{ref}} to this failed node hard-fails on the missing value). For a failed BRANCH, `chosen`
      // is undefined so activate() routes to NO edges — its paths all skip. halt = stop launching anything new.
      if (res.onError === 'continue') { if (node) activate(node, res.chosen); }
      else halted = true;
    }
  } catch (err) {
    // Let any in-flight nodes settle before we leave (their linked agent runs are independently monitored +
    // finalized; we just don't want their promises rejecting unhandled after we've unwound). Then mark the run
    // failed — guarded, since under the same outage that DB write can also reject and would otherwise replace
    // the original error and re-open the unhandled-rejection window (M28).
    await Promise.allSettled(inflight.values());
    try { await setWorkflowRunStatus(run.id, 'failed'); } catch { /* DB blip — the reaper reconciles a stale run */ }
    throw err; // surface ValidationError/etc. to the CLI envelope
  } finally {
    clearInterval(heartbeat);
  }

  // finalStatus is still 'completed' here unless cancellation flipped it. A gate awaiting approval pauses the run
  // (resumable via mc workflow approve) — UNLESS a genuine halt-failure also occurred, which fails outright. A
  // continued failure (no awaiting gate) still fails the run, as before.
  if (finalStatus === 'completed') {
    if (awaiting.size > 0 && !halted) finalStatus = 'paused';
    else if (anyFailed) finalStatus = 'failed';
  }
  await setWorkflowRunStatus(run.id, finalStatus);
  const steps = await listStepRuns(run.id);
  log(`workflow ${slug} run ${run.id.slice(0, 8)} → ${finalStatus}`);
  return { workflowRunId: run.id, status: finalStatus, steps };
}

/** Synchronously RESUME a paused run (slice 9a — the CLI `mc workflow approve` default): race-safe flip
 *  paused→running (so a sync approve and the daemon never both resume the same row) then walk to its next
 *  terminal/paused state. The decision must already be recorded on the gate step (decideGate). Throws
 *  ConflictError if the run is no longer paused (already resumed/cancelled). The web/async path instead
 *  requeues (paused→queued) and lets the daemon resume — neither path spawns from the web tier. */
export async function resumeWorkflowRun(runId: string, opts: RunWorkflowOpts = {}): Promise<RunWorkflowResult> {
  const claimed = await claimPausedWorkflowRun(runId);
  if (!claimed) throw new ConflictError('workflowRun', `run ${runId} is not paused (already resumed or cancelled)`);
  return walkWorkflowRun(claimed, opts);
}

/** Record a node's step as failed (a pre-spawn exit, before/without a runs row). */
async function failStep(wfRunId: string, nodeId: string, error: string): Promise<void> {
  await upsertStepRun(wfRunId, nodeId, { status: 'failed', startedAt: new Date(), endedAt: new Date(), error });
}

// The walker's per-node outcome — `ok` + the captured output (stored on the step, seeds downstream refs) +
// the node's onError policy (so the caller halts or continues). Shared by agent + integration nodes.
// `awaiting` (slice 9a): a gate node that needs a human decision — the scheduler folds it as NON-terminal
// (it neither completes nor fails), so it blocks its successors and the walk quiesces into a 'paused' run.
type NodeResult = { ok: boolean; output?: unknown; onError: WorkflowOnError; awaiting?: boolean };

/** Spawn one agent node as a real run. Interpolates {{nodeId.field}} data-passing refs from `views` first
 *  (an unresolved ref hard-fails the node — the source is missing/failed). Returns `ok` + the captured output
 *  (stored on the step for downstream refs) + the node's onError policy (so the caller halts or continues). */
async function runAgentNode(
  wfRunId: string,
  slug: string,
  node: WorkflowNode,
  home: Project,
  opts: RunWorkflowOpts,
  log: Log,
  views: Map<string, RefView>,
): Promise<NodeResult> {
  const data = readAgentNodeData(node);
  const onError = data.onError ?? 'halt';
  const fail = async (error: string): Promise<NodeResult> => {
    await failStep(wfRunId, node.id, error);
    return { ok: false, onError };
  };

  // Cross-project agent nodes are deferred — a node runs in the workflow's home project.
  if (data.projectSlug && data.projectSlug !== home.slug) {
    throw new ValidationError('node.data.projectSlug', `cross-project nodes are deferred; node "${node.id}" must target the workflow's home project "${home.slug}"`);
  }
  if (!home.repoPath) {
    log(`node ${node.id}: home project has no repoPath — failing step`);
    return fail(`home project "${home.slug}" has no repoPath (set one with: mc project set-repo)`);
  }

  // Data passing: resolve {{nodeId.field}} refs against completed upstream outputs (normalized into `views`
  // by the caller). validateGraph already proved each ref targets an ancestor; a runtime miss (ancestor
  // failed under onError:continue, or no such field) is a hard fail of THIS node (per the missing-ref decision).
  const { text: prompt, missing } = interpolate(data.prompt, views);
  if (missing.length) {
    log(`node ${node.id}: unresolved data refs ${missing.join(', ')} — failing step`);
    return fail(`unresolved data references: ${missing.join(', ')}`);
  }

  // Profile: an explicit slug must exist; otherwise auto-route (may be null → planSpawn's back-compat path).
  const profile = data.profileSlug
    ? await getProfileBySlug(data.profileSlug)
    : await resolveProfile({ projectSlug: home.slug, taskLabel: prompt.split('\n')[0] });
  if (data.profileSlug && !profile) return fail(`profile "${data.profileSlug}" not found`);

  const runId = randomUUID();

  // Open the run through the mc CLI FIRST (run-only visibility: this row drives cost/heartbeat/feed/cancel).
  // It must exist before the step links it — workflow_step_runs.run_id is an FK to runs.id.
  const startArgs = ['run', 'start', '--id', runId, '--agent', AGENT_LABEL, '--project', home.slug, '--source', 'manual', '--title', `workflow:${slug} node:${node.id}`];
  if (profile) startArgs.push('--profile', profile.slug);
  if (profile?.model) startArgs.push('--model', profile.model);
  const started = await mc(startArgs);
  if (!started.ok) return fail(`mc run start failed (${started.error?.code ?? started.code})`);
  const step = await upsertStepRun(wfRunId, node.id, { status: 'running', startedAt: new Date(), runId });

  let spawned;
  try {
    spawned = spawnExecutor({
      prompt, // the interpolated prompt — {{refs}} already substituted with upstream values
      runId,
      repoPath: home.repoPath,
      profile,
      effectiveModel: profile?.model ?? null,
      basePermissionMode: opts.basePermissionMode ?? DEFAULT_PERMISSION_MODE,
      jsonSchema: data.responseSchema, // structured output → captured as result.structured_output
      teeStream: process.stderr, // keep stdout clean for the CLI's JSON envelope
    });
  } catch (e) {
    // MissingEnvError (an unset ${ENV}), a bad exec template, or a declared skill missing on disk
    // (MissingSkillError) — close the run, fail the step. Unlike the other spawn callers this catch emitted no
    // event, so add a skill.unresolved one for the skill-miss case.
    const msg = (e as Error).message;
    if (e instanceof MissingSkillError) {
      await mc(['event', 'add', msg, '--type', 'skill.unresolved', '--level', 'error', '--run', runId, '--project', home.slug]);
    }
    await mc(['run', 'end', runId, 'failed']);
    await setStepRunStatus(step.id, 'failed', { error: msg });
    log(`node ${node.id}: spawn failed — ${msg}`);
    return { ok: false, onError };
  }

  const { status } = await monitorAndFinalize(
    spawned,
    runId,
    { timeoutSec: opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC, graceSec: opts.graceSec ?? DEFAULT_GRACE_SEC },
    log,
  );

  // Persist the resolved prompt alongside the run result so the substrate is fully self-describing (what ran,
  // what came back) — feeds downstream {{nodeId.result|output}} refs and the canvas inspector later.
  const output = { runId, runStatus: status, prompt, result: parseClaudeResult(spawned.output()) };
  const stepStatus = status === 'completed' ? 'completed' : 'failed';
  await setStepRunStatus(step.id, stepStatus, { output, ...(stepStatus === 'failed' ? { error: `run ${status}` } : {}) });
  return { ok: stepStatus === 'completed', output, onError };
}

/** Run one integration node: a single deterministic Composio action, NO LLM (no run row, no spawn, no
 *  monitor — it's the trigger node's twin, not the agent's). Interpolates {{nodeId.field}} refs into the
 *  action arguments type-preserving (a runtime miss hard-fails the node), resolves the project's live
 *  connection for the toolkit, executes, and stores `{ kind, toolkit, action, runStatus, arguments, data }`
 *  on the step — `data` is the Composio response that feeds downstream {{node.output.*}} refs. */
async function runIntegrationNode(
  wfRunId: string,
  node: WorkflowNode,
  home: Project,
  log: Log,
  views: Map<string, RefView>,
): Promise<NodeResult> {
  const data = readIntegrationNodeData(node); // validates toolkit + action + onError (also gated at create)
  const onError = data.onError ?? 'halt';
  const base = { kind: 'integration' as const, toolkit: data.toolkit, action: data.action }; // shared step-output shape
  const fail = async (error: string): Promise<NodeResult> => {
    const output = { ...base, runStatus: 'failed', error };
    await upsertStepRun(wfRunId, node.id, { status: 'failed', startedAt: new Date(), endedAt: new Date(), output, error });
    log(`node ${node.id}: ${error}`);
    return { ok: false, onError };
  };

  // Data passing: resolve {{nodeId.field}} refs inside the arguments, TYPE-PRESERVING (a sole-ref keeps its
  // number/object/array). A runtime miss (source failed under onError:continue, or no such field) hard-fails
  // THIS node — same contract as the agent prompt path.
  const { value: args, missing } = interpolateValue(data.arguments ?? {}, views);
  if (missing.length) return fail(`unresolved data references: ${missing.join(', ')}`);

  // The action runs on behalf of the project's connection for this toolkit — it must be live.
  const conn = await getConnection(home.id, data.toolkit);
  const reauth = `re-auth: mc mcp connect ${home.slug} ${data.toolkit}`;
  if (!conn) return fail(`no ${data.toolkit} connection for project "${home.slug}" (${reauth})`);
  if (conn.status !== 'active') return fail(`${data.toolkit} connection is ${conn.status}, not active (${reauth})`);
  if (!conn.connectedAccountId) return fail(`${data.toolkit} connection has no connected account (${reauth})`);
  if (!conn.userId) return fail(`${data.toolkit} connection has no user id (${reauth})`);

  // Mark running before the (network) action so the canvas overlay shows it in-flight and the reaper can see a
  // mid-action node — same rationale as the agent path's running write (here there's no runId to link).
  await upsertStepRun(wfRunId, node.id, { status: 'running', startedAt: new Date() });
  let composioData: Record<string, unknown>;
  try {
    composioData = await executeIntegration(data.action, conn.connectedAccountId, conn.userId, args as Record<string, unknown>);
  } catch (e) {
    return fail(`composio ${data.action} failed: ${(e as Error).message}`);
  }

  // Store the resolved arguments (observability, like the agent's resolved prompt) + the response data.
  const output = { ...base, runStatus: 'completed', arguments: args, data: composioData };
  await upsertStepRun(wfRunId, node.id, { status: 'completed', endedAt: new Date(), output });
  log(`node ${node.id}: ${data.toolkit}.${data.action} ok`);
  return { ok: true, output, onError };
}

/** Execute the Composio action — or a $0 stub when MC_COMPOSIO_EXEC is set (mirrors MC_DAEMON_EXEC for the
 *  spawn path). The stub is a JSON `{ successful?, data?, error? }`, so tests exercise the whole integration
 *  path with no network call. The real path is lib's pure `executeAction` (keeps the spawn-free lib boundary). */
async function executeIntegration(action: string, connectedAccountId: string, userId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const stub = process.env.MC_COMPOSIO_EXEC;
  if (stub) {
    const parsed = JSON.parse(stub) as { successful?: boolean; data?: Record<string, unknown>; error?: string };
    if (parsed.successful === false) throw new Error(parsed.error || `composio action ${action} failed (stub)`);
    return parsed.data ?? {};
  }
  return executeAction(action, connectedAccountId, userId, args);
}

/** Run one branch node (slice 6a): a deterministic condition pick, NO LLM (no run row, no spawn — the trigger
 *  node's twin). Resolves the ordered cases against {{nodeId.field}} refs and selects the first match (none →
 *  'else'); the walker turns `chosen` into the active out-edges. A missing ref hard-fails the node (same
 *  contract as agent/integration). Stores `{ kind:'branch', runStatus, chosen }` — `chosen` lets a resume
 *  re-route without re-evaluating and lets the canvas show which path was taken. */
async function runBranchNode(
  wfRunId: string,
  node: WorkflowNode,
  log: Log,
  views: Map<string, RefView>,
): Promise<NodeResult & { chosen?: string }> {
  const data = readBranchNodeData(node); // validates cases + onError (also gated at create)
  const onError = data.onError ?? 'halt';
  const { chosen, missing } = chooseBranch(data.cases, views);
  if (missing.length) {
    const error = `unresolved data references: ${missing.join(', ')}`;
    const output = { kind: 'branch', runStatus: 'failed', error };
    await upsertStepRun(wfRunId, node.id, { status: 'failed', startedAt: new Date(), endedAt: new Date(), output, error });
    log(`node ${node.id}: ${error}`);
    return { ok: false, onError };
  }
  const output = { kind: 'branch', runStatus: 'completed', chosen };
  await upsertStepRun(wfRunId, node.id, { status: 'completed', startedAt: new Date(), endedAt: new Date(), output });
  log(`node ${node.id}: branch → ${chosen}`);
  return { ok: true, chosen, output, onError };
}

/** Run one gate node (slice 9a): a HUMAN approval gate, NO LLM. DECISION-DRIVEN & idempotent — it reads its
 *  OWN persisted step (the unique (run,node) row) to learn whether a human has decided yet, so the resume
 *  re-walk re-evaluates it without re-prompting:
 *   • no decision yet → mark the step 'running'/awaiting and return `awaiting` (the scheduler quiesces the run
 *     to 'paused', leaving the step non-terminal so successors stay blocked until approval).
 *   • approved → complete the step (ok) — its successors become decidable on this same walk.
 *   • rejected → fail the step (its onError then halts/continues, exactly like any failed node).
 *  The decision is written onto the step by decideGate (mc workflow approve / the canvas button). */
async function runGateNode(wfRunId: string, node: WorkflowNode, log: Log): Promise<NodeResult> {
  const data = readGateNodeData(node); // validates message + onError (also gated at create)
  const onError = data.onError ?? 'halt';
  const step = await getStepRun(wfRunId, node.id);
  // The human decision decideGate recorded on the step output, or null while still awaiting.
  const out = step?.output;
  const raw = isObject(out) ? out.decision : undefined;
  const decision = raw === 'approve' || raw === 'reject' ? raw : null;

  if (step && decision === 'approve') {
    const output = { kind: 'gate', runStatus: 'completed', decision };
    await setStepRunStatus(step.id, 'completed', { output });
    log(`node ${node.id}: gate approved`);
    return { ok: true, output, onError };
  }
  if (step && decision === 'reject') {
    const error = 'gate rejected';
    const output = { kind: 'gate', runStatus: 'failed', decision, error };
    await setStepRunStatus(step.id, 'failed', { output, error });
    log(`node ${node.id}: gate rejected`);
    return { ok: false, output, onError };
  }
  // No decision: pause here. Mark the step 'running'/awaiting (the canvas shows it; the reaper sees a live run
  // while the walker heartbeats). It stays non-terminal, so its successors never become decidable and the walk
  // quiesces — walkWorkflowRun then settles the run to 'paused'.
  const output = { kind: 'gate', runStatus: 'awaiting', awaiting: true, message: data.message };
  await upsertStepRun(wfRunId, node.id, { status: 'running', startedAt: new Date(), output });
  log(`node ${node.id}: gate awaiting approval`);
  return { ok: true, awaiting: true, output, onError };
}

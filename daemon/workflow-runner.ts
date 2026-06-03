// ABOUTME: The workflow graph walker (slices 1+3+5). Drives a manual-trigger graph: an agent node interpolates
// ABOUTME: {{nodeId.field}} data-passing refs from upstream step outputs, spawns a real run (optionally
// ABOUTME: requesting structured output via responseSchema), and writes run state through the `mc` CLI
// ABOUTME: (mc_agent scoping at the CLI boundary, like auto-claim + scheduler); an integration node runs a
// ABOUTME: deterministic Composio action (no LLM, no run, no spawn). It records per-node step state. RUN-ONLY:
// ABOUTME: an agent node links a runs row (cost/heartbeat/fleet feed/cancel come from it) — it never creates a
// ABOUTME: claimable task. A failed node halts the workflow unless its onError='continue'.
// ABOUTME: Slice 4 split create from walk: runWorkflow (sync, born 'running') and enqueueWorkflowRun (born
// ABOUTME: 'queued', no spawn — the web Run button + `--async`) both create a run; walkWorkflowRun executes an
// ABOUTME: existing run and is shared by the sync path and the workflow-daemon (which claims queued runs).

import { randomUUID } from 'node:crypto';
import { mc, spawnExecutor, monitorAndFinalize, type Log } from './runner';
import {
  getWorkflowById,
  getWorkflowRun,
  createWorkflowRun,
  setWorkflowRunStatus,
  touchWorkflowRun,
  upsertStepRun,
  setStepRunStatus,
  listStepRuns,
} from '../lib/workflow-store';
import { prepareWorkflowRun } from '../lib/workflow-enqueue';
import { topoOrder, nodeById, readAgentNodeData, readIntegrationNodeData } from '../lib/workflows';
import { normalizeStepOutput, interpolate, interpolateValue, type RefView } from '../lib/workflow-refs';
import { getProjectById, getProfileBySlug, resolveProfile } from '../lib/queries';
import { getConnection } from '../lib/composio-store';
import { executeAction } from '../lib/composio-api';
import { NotFoundError, ValidationError } from '../lib/validation';
import type { Project, WorkflowNode, WorkflowOnError, WorkflowRun, WorkflowRunStatus, WorkflowStepRun, WorkflowTrigger } from '../lib/db/schema';

const DEFAULT_TIMEOUT_SEC = 900;
const DEFAULT_GRACE_SEC = 15;
const DEFAULT_PERMISSION_MODE = 'acceptEdits'; // agent nodes need write access; null-profile path uses this
const AGENT_LABEL = 'workflow-runner';

export type RunWorkflowOpts = {
  trigger?: WorkflowTrigger;
  timeoutSec?: number;
  graceSec?: number;
  basePermissionMode?: string;
  allowConcurrent?: boolean; // bypass the single-flight guard
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

  // Resume: nodes a prior attempt already completed are skipped (the (run, node) unique key makes re-running
  // safe). `views` doubles as the skip-set AND the {{nodeId.field}} data-passing substrate — seed it from
  // those completed steps' outputs (normalized once each). Read once up front, not per node.
  const views = new Map<string, RefView>();
  for (const s of await listStepRuns(run.id)) {
    if (s.status === 'completed') views.set(s.nodeId, normalizeStepOutput(s.output));
  }

  let finalStatus: WorkflowRunStatus = 'completed';
  let anyFailed = false; // a node failed but onError='continue' kept the walk going → run ends 'failed'
  try {
    for (const nodeId of topoOrder(snapshot)) {
      // Cancellation is checked between nodes; the active agent node is cancelled via its own runs row.
      if ((await getWorkflowRun(run.id))?.cancelRequested) {
        finalStatus = 'cancelled';
        break;
      }
      await touchWorkflowRun(run.id); // liveness heartbeat for the reaper

      if (views.has(nodeId)) continue; // already completed (this run or a prior attempt)

      const node = nodeById(snapshot, nodeId);
      if (!node) continue; // topoOrder only yields graph node ids; defensive

      if (node.type === 'trigger') {
        const output = { trigger };
        await upsertStepRun(run.id, nodeId, { status: 'completed', startedAt: new Date(), endedAt: new Date(), output });
        views.set(nodeId, normalizeStepOutput(output));
        continue;
      }

      if (node.type === 'agent' || node.type === 'integration') {
        // Agent = a spawned run (LLM); integration = a deterministic Composio action (no run, no spawn). Both
        // capture an output for downstream refs and carry the same halt|continue failure policy.
        const res = node.type === 'agent'
          ? await runAgentNode(run.id, slug, node, home, opts, log, views)
          : await runIntegrationNode(run.id, node, home, log, views);
        if (res.ok) {
          views.set(nodeId, normalizeStepOutput(res.output));
          continue;
        }
        anyFailed = true;
        if (res.onError === 'continue') continue; // keep walking; downstream refs to this node hard-fail
        break; // onError='halt' (default) — stop; the post-loop reconciliation marks the run failed
      }

      // trigger + agent + integration are all the walker executes; anything else is an honest not-yet error.
      throw new ValidationError('node.type', `node type "${node.type}" is not supported yet (the walker handles trigger + agent + integration)`);
    }
  } catch (err) {
    await setWorkflowRunStatus(run.id, 'failed');
    throw err; // surface ValidationError/etc. to the CLI envelope
  }

  if (finalStatus === 'completed' && anyFailed) finalStatus = 'failed'; // a continued failure still fails the run
  await setWorkflowRunStatus(run.id, finalStatus);
  const steps = await listStepRuns(run.id);
  log(`workflow ${slug} run ${run.id.slice(0, 8)} → ${finalStatus}`);
  return { workflowRunId: run.id, status: finalStatus, steps };
}

/** Record a node's step as failed (a pre-spawn exit, before/without a runs row). */
async function failStep(wfRunId: string, nodeId: string, error: string): Promise<void> {
  await upsertStepRun(wfRunId, nodeId, { status: 'failed', startedAt: new Date(), endedAt: new Date(), error });
}

// The walker's per-node outcome — `ok` + the captured output (stored on the step, seeds downstream refs) +
// the node's onError policy (so the caller halts or continues). Shared by agent + integration nodes.
type NodeResult = { ok: boolean; output?: unknown; onError: WorkflowOnError };

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
    : await resolveProfile({ projectSlug: home.slug, taskKind: 'custom', taskLabel: prompt.split('\n')[0] });
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
    // MissingEnvError (an unset ${ENV} in the profile) or a bad exec template — close the run, fail the step.
    await mc(['run', 'end', runId, 'failed']);
    await setStepRunStatus(step.id, 'failed', { error: (e as Error).message });
    log(`node ${node.id}: spawn failed — ${(e as Error).message}`);
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
  const fail = async (error: string): Promise<NodeResult> => {
    const output = { kind: 'integration', toolkit: data.toolkit, action: data.action, runStatus: 'failed', error };
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
  const reauth = `re-auth: mc composio connect ${home.slug} ${data.toolkit}`;
  if (!conn) return fail(`no ${data.toolkit} connection for project "${home.slug}" (${reauth})`);
  if (conn.status !== 'active') return fail(`${data.toolkit} connection is ${conn.status}, not active (${reauth})`);
  if (!conn.connectedAccountId) return fail(`${data.toolkit} connection has no connected account (${reauth})`);

  await upsertStepRun(wfRunId, node.id, { status: 'running', startedAt: new Date() });
  let composioData: Record<string, unknown>;
  try {
    composioData = await executeIntegration(data.action, conn.connectedAccountId, conn.userId, args as Record<string, unknown>);
  } catch (e) {
    return fail(`composio ${data.action} failed: ${(e as Error).message}`);
  }

  // Store the resolved arguments (observability, like the agent's resolved prompt) + the response data.
  const output = { kind: 'integration', toolkit: data.toolkit, action: data.action, runStatus: 'completed', arguments: args, data: composioData };
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

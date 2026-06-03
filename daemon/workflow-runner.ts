// ABOUTME: The workflow graph walker (slices 1+3). Drives a manual-trigger → agent-node graph: for each
// ABOUTME: agent node it interpolates {{nodeId.field}} data-passing refs from upstream step outputs, spawns a
// ABOUTME: real run (optionally requesting structured output via responseSchema), writes run state through the
// ABOUTME: `mc` CLI (mc_agent scoping at the CLI boundary, like auto-claim + scheduler), and records per-node
// ABOUTME: step state. RUN-ONLY: an agent node links a runs row (cost/heartbeat/fleet feed/cancel come from it)
// ABOUTME: — it never creates a claimable task. A failed node halts the workflow unless its onError='continue'.
// ABOUTME: Workflow + step state IS written directly via lib/workflow-store; those writes move behind the mc
// ABOUTME: boundary when async execution lands.

import { randomUUID } from 'node:crypto';
import { mc, spawnExecutor, monitorAndFinalize, type Log } from './runner';
import {
  getWorkflowBySlug,
  getWorkflowRun,
  createWorkflowRun,
  countActiveWorkflowRuns,
  setWorkflowRunStatus,
  touchWorkflowRun,
  upsertStepRun,
  setStepRunStatus,
  listStepRuns,
} from '../lib/workflow-store';
import { validateGraph, topoOrder, nodeById, readAgentNodeData } from '../lib/workflows';
import { normalizeStepOutput, interpolate, type RefView } from '../lib/workflow-refs';
import { getProjectById, getProfileBySlug, resolveProfile } from '../lib/queries';
import { NotFoundError, ConflictError, ValidationError } from '../lib/validation';
import type { Project, WorkflowNode, WorkflowOnError, WorkflowRunStatus, WorkflowStepRun, WorkflowTrigger } from '../lib/db/schema';

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

/** Walk a workflow's graph to completion. Synchronous (slice 1): the calling process supervises the run, so
 *  keep prompts short — durable/async execution + full reaper reconciliation arrive with the slice-4 daemon. */
export async function runWorkflow(slug: string, opts: RunWorkflowOpts = {}): Promise<RunWorkflowResult> {
  const log = opts.log ?? (() => {});
  const wf = await getWorkflowBySlug(slug);
  if (!wf) throw new NotFoundError('workflow', slug, "run 'mc workflow list' to see slugs");
  validateGraph(wf.graph); // ValidationError on a malformed graph (single source of truth)

  if (!opts.allowConcurrent && (await countActiveWorkflowRuns(wf.id)) > 0) {
    throw new ConflictError('workflow', `workflow "${slug}" already has a run in progress`);
  }

  const home = await getProjectById(wf.projectId);
  if (!home) throw new NotFoundError('project', wf.projectId, "the workflow's home project was deleted");

  const snapshot = wf.graph; // pinned onto the run so a mid-run edit can't corrupt this walk
  const wfRun = await createWorkflowRun({ workflowId: wf.id, trigger: opts.trigger ?? 'manual', graphSnapshot: snapshot });
  log(`workflow ${slug} run ${wfRun.id.slice(0, 8)} started (${snapshot.nodes.length} nodes)`);

  // Resume: nodes a prior attempt already completed are skipped (the (run, node) unique key makes re-running
  // safe). `views` doubles as the skip-set AND the {{nodeId.field}} data-passing substrate — seed it from
  // those completed steps' outputs (normalized once each) so refs resolve even across a resume. Read once up
  // front — fixed at run start — not per node.
  const views = new Map<string, RefView>();
  for (const s of await listStepRuns(wfRun.id)) {
    if (s.status === 'completed') views.set(s.nodeId, normalizeStepOutput(s.output));
  }

  let finalStatus: WorkflowRunStatus = 'completed';
  let anyFailed = false; // a node failed but onError='continue' kept the walk going → run ends 'failed'
  try {
    for (const nodeId of topoOrder(snapshot)) {
      // Cancellation is checked between nodes; the active agent node is cancelled via its own runs row.
      if ((await getWorkflowRun(wfRun.id))?.cancelRequested) {
        finalStatus = 'cancelled';
        break;
      }
      await touchWorkflowRun(wfRun.id); // liveness heartbeat for the reaper

      if (views.has(nodeId)) continue; // already completed (this run or a prior attempt)

      const node = nodeById(snapshot, nodeId);
      if (!node) continue; // topoOrder only yields graph node ids; defensive

      if (node.type === 'trigger') {
        const output = { trigger: opts.trigger ?? 'manual' };
        await upsertStepRun(wfRun.id, nodeId, { status: 'completed', startedAt: new Date(), endedAt: new Date(), output });
        views.set(nodeId, normalizeStepOutput(output));
        continue;
      }

      if (node.type === 'agent') {
        const res = await runAgentNode(wfRun.id, slug, node, home, opts, log, views);
        if (res.ok) {
          views.set(nodeId, normalizeStepOutput(res.output));
          continue;
        }
        anyFailed = true;
        if (res.onError === 'continue') continue; // keep walking; downstream refs to this node hard-fail
        break; // onError='halt' (default) — stop; the post-loop reconciliation marks the run failed
      }

      // trigger + agent are all the walker executes; anything else is an honest not-yet error.
      throw new ValidationError('node.type', `node type "${node.type}" is not supported yet (the walker handles trigger + agent)`);
    }
  } catch (err) {
    await setWorkflowRunStatus(wfRun.id, 'failed');
    throw err; // surface ValidationError/etc. to the CLI envelope
  }

  if (finalStatus === 'completed' && anyFailed) finalStatus = 'failed'; // a continued failure still fails the run
  await setWorkflowRunStatus(wfRun.id, finalStatus);
  const steps = await listStepRuns(wfRun.id);
  log(`workflow ${slug} run ${wfRun.id.slice(0, 8)} → ${finalStatus}`);
  return { workflowRunId: wfRun.id, status: finalStatus, steps };
}

/** Record a node's step as failed (a pre-spawn exit, before/without a runs row). */
async function failStep(wfRunId: string, nodeId: string, error: string): Promise<void> {
  await upsertStepRun(wfRunId, nodeId, { status: 'failed', startedAt: new Date(), endedAt: new Date(), error });
}

type AgentNodeResult = { ok: boolean; output?: unknown; onError: WorkflowOnError };

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
): Promise<AgentNodeResult> {
  const data = readAgentNodeData(node);
  const onError = data.onError ?? 'halt';
  const fail = async (error: string): Promise<AgentNodeResult> => {
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

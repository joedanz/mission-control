// ABOUTME: The workflow graph walker (slice 1). Drives a manual-trigger → agent-node graph: for each agent
// ABOUTME: node it spawns a real run via the shared runner primitives (spawnExecutor/monitorAndFinalize),
// ABOUTME: writes run state through the `mc` CLI (so mc_agent scoping stays at the CLI boundary, like the
// ABOUTME: auto-claim + scheduler daemons), and records per-node step state. RUN-ONLY: an agent node links a
// ABOUTME: runs row (cost/heartbeat/fleet feed/cancel come from it) — it never creates a claimable task.
// ABOUTME: Workflow + step state IS written directly via lib/workflow-store (new runner-owned tables, no
// ABOUTME: mc_agent-sensitive surface yet); those writes move behind the mc boundary when async execution lands.

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
import { getProjectById, getProfileBySlug, resolveProfile } from '../lib/queries';
import { NotFoundError, ConflictError, ValidationError } from '../lib/validation';
import type { Project, WorkflowNode, WorkflowRunStatus, WorkflowStepRun, WorkflowTrigger } from '../lib/db/schema';

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
  // safe). Read once up front — the set is fixed at run start — instead of re-reading the step list per node.
  const completed = new Set((await listStepRuns(wfRun.id)).filter((s) => s.status === 'completed').map((s) => s.nodeId));

  let finalStatus: WorkflowRunStatus = 'completed';
  try {
    for (const nodeId of topoOrder(snapshot)) {
      // Cancellation is checked between nodes; the active agent node is cancelled via its own runs row.
      if ((await getWorkflowRun(wfRun.id))?.cancelRequested) {
        finalStatus = 'cancelled';
        break;
      }
      await touchWorkflowRun(wfRun.id); // liveness heartbeat for the reaper

      if (completed.has(nodeId)) continue;

      const node = nodeById(snapshot, nodeId);
      if (!node) continue; // topoOrder only yields graph node ids; defensive

      if (node.type === 'trigger') {
        await upsertStepRun(wfRun.id, nodeId, {
          status: 'completed',
          startedAt: new Date(),
          endedAt: new Date(),
          output: { trigger: opts.trigger ?? 'manual' },
        });
        continue;
      }

      if (node.type === 'agent') {
        const ok = await runAgentNode(wfRun.id, slug, node, home, opts, log);
        if (!ok) {
          finalStatus = 'failed';
          break; // halt the workflow on a failed step (slice 1; onError policy lands in slice 3)
        }
        continue;
      }

      // trigger + agent are all slice 1 supports; anything else is an honest not-yet error.
      throw new ValidationError('node.type', `node type "${node.type}" is not supported yet (slice 1 handles trigger + agent)`);
    }
  } catch (err) {
    await setWorkflowRunStatus(wfRun.id, 'failed');
    throw err; // surface ValidationError/etc. to the CLI envelope
  }

  await setWorkflowRunStatus(wfRun.id, finalStatus);
  const steps = await listStepRuns(wfRun.id);
  log(`workflow ${slug} run ${wfRun.id.slice(0, 8)} → ${finalStatus}`);
  return { workflowRunId: wfRun.id, status: finalStatus, steps };
}

/** Record a node's step as failed (a pre-spawn exit, before/without a runs row). */
async function failStep(wfRunId: string, nodeId: string, error: string): Promise<void> {
  await upsertStepRun(wfRunId, nodeId, { status: 'failed', startedAt: new Date(), endedAt: new Date(), error });
}

/** Spawn one agent node as a real run. Returns true on a completed run, false on any failure (caller halts). */
async function runAgentNode(
  wfRunId: string,
  slug: string,
  node: WorkflowNode,
  home: Project,
  opts: RunWorkflowOpts,
  log: Log,
): Promise<boolean> {
  const data = readAgentNodeData(node);

  // Cross-project agent nodes are deferred — a slice-1 node runs in the workflow's home project.
  if (data.projectSlug && data.projectSlug !== home.slug) {
    throw new ValidationError('node.data.projectSlug', `cross-project nodes are deferred; node "${node.id}" must target the workflow's home project "${home.slug}"`);
  }
  if (!home.repoPath) {
    await failStep(wfRunId, node.id, `home project "${home.slug}" has no repoPath (set one with: mc project set-repo)`);
    log(`node ${node.id}: home project has no repoPath — failing step`);
    return false;
  }

  // Profile: an explicit slug must exist; otherwise auto-route (may be null → planSpawn's back-compat path).
  const profile = data.profileSlug
    ? await getProfileBySlug(data.profileSlug)
    : await resolveProfile({ projectSlug: home.slug, taskKind: 'custom', taskLabel: data.prompt.split('\n')[0] });
  if (data.profileSlug && !profile) {
    await failStep(wfRunId, node.id, `profile "${data.profileSlug}" not found`);
    return false;
  }

  const runId = randomUUID();

  // Open the run through the mc CLI FIRST (run-only visibility: this row drives cost/heartbeat/feed/cancel).
  // It must exist before the step links it — workflow_step_runs.run_id is an FK to runs.id.
  const startArgs = ['run', 'start', '--id', runId, '--agent', AGENT_LABEL, '--project', home.slug, '--source', 'manual', '--title', `workflow:${slug} node:${node.id}`];
  if (profile) startArgs.push('--profile', profile.slug);
  if (profile?.model) startArgs.push('--model', profile.model);
  const started = await mc(startArgs);
  if (!started.ok) {
    await failStep(wfRunId, node.id, `mc run start failed (${started.error?.code ?? started.code})`);
    return false;
  }
  const step = await upsertStepRun(wfRunId, node.id, { status: 'running', startedAt: new Date(), runId });

  let spawned;
  try {
    spawned = spawnExecutor({
      prompt: data.prompt,
      runId,
      repoPath: home.repoPath,
      profile,
      effectiveModel: profile?.model ?? null,
      basePermissionMode: opts.basePermissionMode ?? DEFAULT_PERMISSION_MODE,
      teeStream: process.stderr, // keep stdout clean for the CLI's JSON envelope
    });
  } catch (e) {
    // MissingEnvError (an unset ${ENV} in the profile) or a bad exec template — close the run, fail the step.
    await mc(['run', 'end', runId, 'failed']);
    await setStepRunStatus(step.id, 'failed', { error: (e as Error).message });
    log(`node ${node.id}: spawn failed — ${(e as Error).message}`);
    return false;
  }

  const { status } = await monitorAndFinalize(
    spawned,
    runId,
    { timeoutSec: opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC, graceSec: opts.graceSec ?? DEFAULT_GRACE_SEC },
    log,
  );

  const output = { runId, runStatus: status, result: parseClaudeResult(spawned.output()) };
  const stepStatus = status === 'completed' ? 'completed' : 'failed';
  await setStepRunStatus(step.id, stepStatus, { output, ...(stepStatus === 'failed' ? { error: `run ${status}` } : {}) });
  return stepStatus === 'completed';
}

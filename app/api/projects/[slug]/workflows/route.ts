// ABOUTME: Workflows feed + run trigger for a project's canvas tab. GET lists the project's workflows (with a
// ABOUTME: latest-run summary); GET ?workflow=<slug> returns one workflow's graph + recent runs + the latest
// ABOUTME: run's per-node step status (the live overlay). POST {workflow,action:'run'} ENQUEUES a run (status
// ABOUTME: 'queued') for the workflow-daemon to execute — the web tier never spawns, it only writes the queued
// ABOUTME: row (plan correction #2). Session-gated, {ok,data} envelope — mirrors /api/board + the composio POST.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getProjectBySlug } from '@/lib/queries';
import { listWorkflows, getWorkflowBySlug, getWorkflowById, getWorkflowRun, requeueWorkflowRun, listWorkflowRuns, listStepRuns } from '@/lib/workflow-store';
import { enqueueWorkflowRun, decideGate, saveWorkflowGraph, createDraftWorkflow } from '@/lib/workflow-enqueue';
import { toWorkflowListItem, toWorkflowDetail } from '@/lib/workflow-view';
import { NotFoundError, ConflictError, ValidationError } from '@/lib/validation';
import type { WorkflowGraph } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Returns a 401 Response if the caller isn't allowed, else null. Rethrows non-auth errors. */
async function gate(): Promise<Response | null> {
  try {
    await requireAllowedUser();
    return null;
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    throw e;
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const denied = await gate();
  if (denied) return denied;

  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });

  const wfSlug = new URL(request.url).searchParams.get('workflow') ?? undefined;

  // Detail: one workflow's graph + the latest run's per-node step overlay.
  if (wfSlug) {
    const wf = await getWorkflowBySlug(wfSlug);
    if (!wf || wf.projectId !== project.id) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    const runs = await listWorkflowRuns({ workflowId: wf.id, limit: 1 }); // only the latest run is rendered
    const steps = runs.length ? await listStepRuns(runs[0].id) : [];
    return Response.json({ ok: true, data: { workflow: toWorkflowDetail(wf, runs, steps) } });
  }

  // List: the project's workflows, each with its latest-run summary (parallel — avoids a serial N+1).
  const workflows = await listWorkflows({ projectId: project.id });
  const items = await Promise.all(
    workflows.map(async (wf) => {
      const [latest] = await listWorkflowRuns({ workflowId: wf.id, limit: 1 });
      return toWorkflowListItem(wf, latest ?? null);
    }),
  );
  return Response.json({ ok: true, data: { workflows: items } });
}

type PostBody = { action?: string; workflow?: string; runId?: string; nodeId?: string; decision?: string; reason?: string; graph?: WorkflowGraph; name?: string };

/** Trigger a workflow run from the canvas Run button. Enqueues a 'queued' run for the workflow-daemon — a pure
 *  DB write, no spawn. The single-flight guard surfaces as 409 (a run is already queued or in progress). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const denied = await gate();
  if (denied) return denied;

  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return Response.json({ ok: false, error: 'validation', message: 'invalid JSON body' }, { status: 422 });
  }
  const { action } = body;

  try {
    // Approve / reject a paused gate (slice 9a): record the decision (decideGate) then requeue the run
    // (paused→queued) so the workflow-daemon resumes it off-process — the web tier never spawns.
    if (action === 'approve') {
      const { runId, nodeId, decision, reason } = body;
      if (!runId || !nodeId) return Response.json({ ok: false, error: 'validation', message: 'runId and nodeId required' }, { status: 422 });
      if (decision !== 'approve' && decision !== 'reject') return Response.json({ ok: false, error: 'validation', message: "decision must be 'approve' or 'reject'" }, { status: 422 });
      // Foreign-project guard: the run's workflow must belong to THIS project.
      const run = await getWorkflowRun(runId);
      if (!run) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
      const ownerWf = await getWorkflowById(run.workflowId);
      if (!ownerWf || ownerWf.projectId !== project.id) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
      await decideGate(run, nodeId, decision, reason);
      const requeued = await requeueWorkflowRun(runId);
      if (!requeued) return Response.json({ ok: false, error: 'conflict', message: `run ${runId} is no longer paused` }, { status: 409 });
      return Response.json({ ok: true, data: { workflowRunId: requeued.id, status: requeued.status, decision } });
    }

    // Create a new EMPTY draft workflow from the canvas "New workflow" button (slice 9c) — a pure DB write,
    // no spawn, so authoring a workflow from zero never needs the CLI. ValidationError (blank name) → 422,
    // ConflictError (slug taken) → 409, both via the shared catch below.
    if (action === 'create') {
      const { name } = body;
      if (!name || !name.trim()) return Response.json({ ok: false, error: 'validation', message: 'a workflow name is required' }, { status: 422 });
      const created = await createDraftWorkflow(project.id, name);
      return Response.json({ ok: true, data: { workflow: { slug: created.slug, name: created.name, status: created.status } } });
    }

    // Save an edited graph (slice 9b canvas authoring): the foreign-project guard here, then the shared
    // saveWorkflowGraph (same lib-tier validate-then-persist the CLI uses) — a pure DB write, no spawn.
    // ValidationError (a non-empty graph that doesn't validate) → 422, caught below; invalid never persists.
    if (action === 'save') {
      const { workflow: wfSlug, graph } = body;
      if (!wfSlug) return Response.json({ ok: false, error: 'validation', message: 'workflow required' }, { status: 422 });
      if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
        return Response.json({ ok: false, error: 'validation', message: 'graph must have nodes and edges arrays' }, { status: 422 });
      }
      const wf = await getWorkflowBySlug(wfSlug);
      if (!wf || wf.projectId !== project.id) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
      const saved = await saveWorkflowGraph(wfSlug, { graph });
      return Response.json({ ok: true, data: { workflow: { slug: saved.slug, version: saved.version, status: saved.status } } });
    }

    if (action !== 'run') {
      return Response.json({ ok: false, error: 'validation', message: `unknown action: ${String(action)}` }, { status: 422 });
    }
    const { workflow: wfSlug } = body;
    if (!wfSlug) {
      return Response.json({ ok: false, error: 'validation', message: 'workflow required' }, { status: 422 });
    }
    // Foreign-project guard: the workflow must belong to THIS project (mirrors the GET detail check).
    const wf = await getWorkflowBySlug(wfSlug);
    if (!wf || wf.projectId !== project.id) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    const run = await enqueueWorkflowRun(wfSlug, { trigger: 'manual' });
    return Response.json({ ok: true, data: { workflowRunId: run.id, status: run.status } });
  } catch (e) {
    if (e instanceof ConflictError) {
      return Response.json({ ok: false, error: 'conflict', message: e.message }, { status: 409 });
    }
    if (e instanceof ValidationError) {
      return Response.json({ ok: false, error: 'validation', message: e.message }, { status: 422 });
    }
    if (e instanceof NotFoundError) {
      return Response.json({ ok: false, error: 'not_found', message: e.message }, { status: 404 });
    }
    throw e;
  }
}

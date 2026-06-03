// ABOUTME: Workflows feed + run trigger for a project's canvas tab. GET lists the project's workflows (with a
// ABOUTME: latest-run summary); GET ?workflow=<slug> returns one workflow's graph + recent runs + the latest
// ABOUTME: run's per-node step status (the live overlay). POST {workflow,action:'run'} ENQUEUES a run (status
// ABOUTME: 'queued') for the workflow-daemon to execute — the web tier never spawns, it only writes the queued
// ABOUTME: row (plan correction #2). Session-gated, {ok,data} envelope — mirrors /api/board + the composio POST.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getProjectBySlug } from '@/lib/queries';
import { listWorkflows, getWorkflowBySlug, listWorkflowRuns, listStepRuns } from '@/lib/workflow-store';
import { enqueueWorkflowRun } from '@/lib/workflow-enqueue';
import { toWorkflowListItem, toWorkflowDetail } from '@/lib/workflow-view';
import { NotFoundError, ConflictError, ValidationError } from '@/lib/validation';

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

type PostBody = { action?: string; workflow?: string };

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
  const { action, workflow: wfSlug } = body;
  if (action !== 'run') {
    return Response.json({ ok: false, error: 'validation', message: `unknown action: ${String(action)}` }, { status: 422 });
  }
  if (!wfSlug) {
    return Response.json({ ok: false, error: 'validation', message: 'workflow required' }, { status: 422 });
  }
  // Foreign-project guard: the workflow must belong to THIS project (mirrors the GET detail check).
  const wf = await getWorkflowBySlug(wfSlug);
  if (!wf || wf.projectId !== project.id) {
    return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  try {
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

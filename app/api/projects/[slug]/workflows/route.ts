// ABOUTME: Read-only workflows feed for a project's canvas tab. GET lists the project's workflows (with a
// ABOUTME: latest-run summary); GET ?workflow=<slug> returns one workflow's graph + recent runs + the latest
// ABOUTME: run's per-node step status (the live overlay). Session-gated, {ok,data} envelope — mirrors /api/board.
// ABOUTME: Read-only by design: the execution trigger is daemon-driven (slice 4); the web tier never spawns.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getProjectBySlug } from '@/lib/queries';
import { listWorkflows, getWorkflowBySlug, listWorkflowRuns, listStepRuns } from '@/lib/workflow-store';
import { toWorkflowListItem, toWorkflowDetail } from '@/lib/workflow-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    await requireAllowedUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    throw e;
  }

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

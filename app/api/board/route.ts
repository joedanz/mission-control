// ABOUTME: GET board data (custom tasks grouped per project + recent runs) for the Kanban board's poll hook.
// ABOUTME: Session-authenticated (requireAllowedUser). Mirrors /api/activity: lean projection, {ok,data} envelope.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getProjectBySlug, getProjectsWithTasks, getRecentRuns } from '@/lib/queries';
import { toBoardProject } from '@/lib/board';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAllowedUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    throw e;
  }

  const slug = new URL(request.url).searchParams.get('project') ?? undefined;

  if (slug) {
    const [project, runs] = await Promise.all([getProjectBySlug(slug), getRecentRuns({ active: true })]);
    if (!project) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    return Response.json({ ok: true, data: { projects: [toBoardProject(project, false)], runs } });
  }

  const [all, runs] = await Promise.all([
    getProjectsWithTasks({ archived: 'active' }),
    getRecentRuns({ active: true }),
  ]);
  return Response.json({ ok: true, data: { projects: all.map((p) => toBoardProject(p, true)), runs } });
}

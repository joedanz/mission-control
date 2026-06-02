// ABOUTME: GET activity feed (events >= info) + recent runs, for the Mission tab's polling hook.
// ABOUTME: Session-authenticated (requireAllowedUser) — NOT the bearer-auth ingest path.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getActivityFeed, getRecentRuns } from '@/lib/queries';

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

  const url = new URL(request.url);
  const projectId = url.searchParams.get('projectId') ?? undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);

  const [events, runs] = await Promise.all([
    getActivityFeed({ projectId, limit }),
    // runs are global (a fleet view); the per-project tab ignores them
    projectId ? Promise.resolve([]) : getRecentRuns({ limit: 20 }),
  ]);

  return Response.json({ ok: true, data: { events, runs } });
}

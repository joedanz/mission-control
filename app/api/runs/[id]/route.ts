// ABOUTME: GET a single run with its events, for the run drill-in page's polling hook.
// ABOUTME: Session-authenticated (requireAllowedUser) — same auth as /api/activity, NOT the ingest bearer path.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getRunById } from '@/lib/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireAllowedUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    throw e;
  }

  const { id } = await params;
  const run = await getRunById(id);
  if (!run) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });

  return Response.json({ ok: true, data: { run } });
}

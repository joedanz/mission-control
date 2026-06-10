// ABOUTME: HTTP trigger to reap stale `running` runs → 'abandoned' AND reconcile dangling claims of
// ABOUTME: terminal runs. Bearer-auth via CRON_SECRET. OPTIONAL — the default is to run the reaper
// ABOUTME: locally via `npm run reap` (see LAUNCH.md); this route lets an external scheduler do it over HTTP.

import { runReaperTick } from '@/lib/mutations';
import { bearerMatches } from '@/lib/bearer-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!bearerMatches(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const { reaped, reconciled, staleWorkflows } = await runReaperTick();
  return Response.json({
    ok: true,
    data: {
      reaped: reaped.length,
      ids: reaped.map((r) => r.id),
      reconciled: reconciled.length,
      staleWorkflows: staleWorkflows.length,
    },
  });
}

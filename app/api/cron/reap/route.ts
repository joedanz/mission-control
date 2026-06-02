// ABOUTME: HTTP trigger to reap stale `running` runs → 'abandoned' AND reconcile dangling claims of
// ABOUTME: terminal runs. Bearer-auth via CRON_SECRET. OPTIONAL — the default is to run the reaper
// ABOUTME: locally via `npm run reap` (see LAUNCH.md); this route lets an external scheduler do it over HTTP.

import { runReaperTick } from '@/lib/mutations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const { reaped, reconciled } = await runReaperTick();
  return Response.json({
    ok: true,
    data: { reaped: reaped.length, ids: reaped.map((r) => r.id), reconciled: reconciled.length },
  });
}

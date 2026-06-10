// ABOUTME: Auth-gate test for GET /api/cron/reap — the second bearer-token prod surface (CRON_SECRET),
// ABOUTME: previously untested. Measures the security property DIRECTLY (like the ingest suite): a stale
// ABOUTME: `running` run survives an unauthenticated / wrong / secret-unset request — proof the reaper
// ABOUTME: never ran — and only flips to 'abandoned' under a correct Bearer. The route imports only
// ABOUTME: lib/mutations (no 'server-only'/next-headers), so it loads cleanly under vitest's node env.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { GET } from '../app/api/cron/reap/route';
import { db } from '../lib/db/index';
import { projects, runs, events } from '../lib/db/schema';
import { createProject, recordRunStart } from '../lib/mutations';

const SECRET = 'test-cron-secret-abc123';

function req(authorization?: string): Request {
  return new Request('http://localhost/api/cron/reap', authorization ? { headers: { authorization } } : {});
}

async function statusOf(id: string): Promise<string | undefined> {
  const rows = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, id));
  return rows[0]?.status;
}

describe('GET /api/cron/reap — CRON_SECRET bearer gate', () => {
  let projectId: string;
  let staleRunId: string;
  const prevSecret = process.env.CRON_SECRET;

  beforeEach(async () => {
    process.env.CRON_SECRET = SECRET;
    const p = await createProject({
      name: `vitest-reap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      category: 'internal',
      status: 'prelaunch',
    });
    projectId = p.id;
    const r = await recordRunStart({ agentLabel: 'vitest-reap', projectId });
    staleRunId = r.id;
    // Leave the heartbeat FRESH here: a stale run is a target for the documented always-on `npm run reap`
    // service (every 60s), which would race this test and abandon it mid-assertion. The unauthorized cases
    // only need a 'running' run no reaper touches (proving the gate returns 401 before any reaping); the
    // authorized case ages the heartbeat itself, just before its request, to verify the reaper DOES run.
  });

  /** Age the run's heartbeat past RUN_STALE_THRESHOLD_SEC so a reaper would abandon it. */
  async function makeStale(id: string) {
    await db.update(runs).set({ lastHeartbeatAt: sql`now() - interval '1 hour'` }).where(eq(runs.id, id));
  }

  afterEach(async () => {
    if (prevSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevSecret;
    await db.delete(events).where(eq(events.runId, staleRunId));
    await db.delete(events).where(eq(events.projectId, projectId));
    await db.delete(runs).where(eq(runs.id, staleRunId));
    await db.delete(projects).where(eq(projects.id, projectId)); // cascades tasks
  });

  it('no Authorization header → 401 and the stale run is NOT reaped', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(await statusOf(staleRunId)).toBe('running'); // the gate ran BEFORE the reaper could touch it
  });

  it('wrong bearer → 401 and the stale run is NOT reaped', async () => {
    const res = await GET(req('Bearer not-the-secret'));
    expect(res.status).toBe(401);
    expect(await statusOf(staleRunId)).toBe('running');
  });

  it('CRON_SECRET unset → 401 even with a Bearer header (fail-closed)', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req('Bearer anything'));
    expect(res.status).toBe(401);
    expect(await statusOf(staleRunId)).toBe('running');
  });

  it('correct bearer → 200 and a stale run flips to abandoned', async () => {
    await makeStale(staleRunId); // only now — so the unauthorized cases above never raced the real reaper
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(await statusOf(staleRunId)).toBe('abandoned');
  });
});

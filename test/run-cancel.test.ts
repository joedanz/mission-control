// ABOUTME: Tests for setRunCancelRequested — the operator kill-switch WRITE half (the request side; no
// ABOUTME: enforcement). Pins: running→flag+event, terminal→Conflict, missing→null, idempotent (one event),
// ABOUTME: and that it stays ORTHOGONAL to liveness (never touches lastHeartbeatAt, so the reaper is unaffected).
//
// Runs against the real Neon instance (DATABASE_URL), serially (vitest fileParallelism:false). Each test
// scopes its assertions to a throwaway project so it's deterministic.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, runs, events } from '../lib/db/schema';
import { createProject, recordRunStart, setRunCancelRequested } from '../lib/mutations';
import { getEvents } from '../lib/queries';
import { ConflictError } from '../lib/validation';

let projectId: string;
let runIds: string[];

beforeEach(async () => {
  runIds = [];
  const p = await createProject({
    name: `vitest-cancel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category: 'internal',
    status: 'prelaunch',
  });
  projectId = p.id;
});

afterEach(async () => {
  await db.delete(events).where(eq(events.projectId, projectId));
  if (runIds.length) await db.delete(runs).where(inArray(runs.id, runIds));
  await db.delete(projects).where(eq(projects.id, projectId)); // cascades tasks
});

async function mkRun() {
  const r = await recordRunStart({ agentLabel: 'vitest', projectId });
  runIds.push(r.id);
  return r;
}

const MISSING = '00000000-0000-0000-0000-000000000000';

describe('setRunCancelRequested', () => {
  it('flags a running run and emits run.cancel_requested; status stays running', async () => {
    const r = await mkRun();
    expect(r.cancelRequested).toBe(false);

    const updated = await setRunCancelRequested(r.id);
    expect(updated).not.toBeNull();
    expect(updated!.cancelRequested).toBe(true);
    expect(updated!.status).toBe('running'); // request flag is orthogonal to status

    const evs = await getEvents({ runId: r.id });
    const ev = evs.find((e) => e.type === 'run.cancel_requested');
    expect(ev).toBeDefined();
    expect(ev!.summary).toContain('Cancel requested');
    expect(ev!.level).toBe('warn'); // operator intervention surfaces louder than routine run.* events

  });

  it('does NOT touch lastHeartbeatAt — stays orthogonal to liveness so the reaper is unaffected', async () => {
    const r = await mkRun();
    const updated = await setRunCancelRequested(r.id);
    // The load-bearing assertion: cancel must not bump the heartbeat clock, or a genuinely-dead
    // run would look alive and never get abandoned.
    expect(updated!.lastHeartbeatAt.getTime()).toBe(r.lastHeartbeatAt.getTime());
  });

  it('returns null for a missing run (CLI maps null → NotFound), without throwing', async () => {
    await expect(setRunCancelRequested(MISSING)).resolves.toBeNull();
  });

  it('throws ConflictError when the run already ended (completed)', async () => {
    const r = await mkRun();
    await db.update(runs).set({ status: 'completed', endedAt: new Date() }).where(eq(runs.id, r.id));
    await expect(setRunCancelRequested(r.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('throws ConflictError when the run was abandoned by the reaper', async () => {
    const r = await mkRun();
    await db.update(runs).set({ status: 'abandoned', endedAt: new Date() }).where(eq(runs.id, r.id));
    await expect(setRunCancelRequested(r.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('is idempotent: requesting twice stays flagged and logs exactly one event (deduped by key)', async () => {
    const r = await mkRun();
    await setRunCancelRequested(r.id);
    const second = await setRunCancelRequested(r.id); // still running → succeeds again
    expect(second!.cancelRequested).toBe(true);

    const evs = await getEvents({ runId: r.id });
    const cancels = evs.filter((e) => e.type === 'run.cancel_requested');
    expect(cancels).toHaveLength(1); // idempotencyKey dedup → one event
  });
});

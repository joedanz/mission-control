// ABOUTME: Lifecycle tests for the self-dispatch claim machinery — the repo's most concurrency-critical,
// ABOUTME: transaction-less code. Pins claimTask / getNextClaimableTask / terminalize / release / reaper / TTL.
//
// Runs against the real Neon instance (DATABASE_URL). Each test works inside a throwaway project and
// cleans up after itself; the suite runs serially (vitest fileParallelism:false) since it shares one DB.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, runs, events } from '../lib/db/schema';
import {
  createProject,
  addTask,
  claimTask,
  setTaskStatus,
  importTasks,
  recordRunStart,
  recordRunEnd,
  reapStaleRuns,
  reconcileTerminalClaims,
} from '../lib/mutations';
import { getTaskById, getNextClaimableTask, getRecentRuns } from '../lib/queries';
import { ConflictError } from '../lib/validation';

let projectId: string;
let runIds: string[];

beforeEach(async () => {
  runIds = [];
  const p = await createProject({
    name: `vitest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

describe('claimTask', () => {
  it('claims a todo custom task and leaves status todo (orthogonal to status)', async () => {
    const r = await mkRun();
    const t = await addTask(projectId, 'A');
    const claimed = await claimTask(t.id, r.id);
    expect(claimed?.claimedByRunId).toBe(r.id);
    expect(claimed?.status).toBe('todo');
    expect(claimed?.claimExpiresAt).toBeTruthy();
  });

  it('a live claim makes a second claimer lose with ConflictError (race-safe)', async () => {
    const r1 = await mkRun();
    const r2 = await mkRun();
    const t = await addTask(projectId, 'A');
    await claimTask(t.id, r1.id);
    await expect(claimTask(t.id, r2.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('under CONCURRENT claimers, exactly one wins and the rest get ConflictError', async () => {
    // The test above is sequential (r1 fully resolves before r2). This fires N claims on one fresh task
    // at once, so the single-statement conditional UPDATE is the ONLY thing serializing them — a future
    // read-then-write (TOCTOU) refactor would let two win here and fail. (neon-http sends each as its own
    // round-trip, so Postgres row-locking does the serialization; that's exactly the guarantee we pin.)
    const t = await addTask(projectId, 'contended');
    const claimers = await Promise.all(Array.from({ length: 5 }, () => mkRun()));
    const results = await Promise.allSettled(claimers.map((r) => claimTask(t.id, r.id)));

    const winners = results.filter((x) => x.status === 'fulfilled' && x.value?.claimedByRunId);
    const conflicts = results.filter((x) => x.status === 'rejected' && x.reason instanceof ConflictError);
    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(4); // every loser is a CONFLICT, not a silent null or a second winner

    // the DB agrees: the task is claimed by exactly the one run that won the race
    const winnerRunId = (winners[0] as PromiseFulfilledResult<{ claimedByRunId: string }>).value.claimedByRunId;
    expect((await getTaskById(t.id))!.claimedByRunId).toBe(winnerRunId);
  });

  it('an absent task returns null (NotFound)', async () => {
    const r = await mkRun();
    await expect(claimTask(ZERO_UUID, r.id)).resolves.toBeNull();
  });

  it('an expired claim is re-claimable by another run', async () => {
    const r1 = await mkRun();
    const r2 = await mkRun();
    const t = await addTask(projectId, 'A');
    await claimTask(t.id, r1.id, -10); // already-expired claim
    const reclaimed = await claimTask(t.id, r2.id);
    expect(reclaimed?.claimedByRunId).toBe(r2.id);
  });
});

// Edge 1: one-claim-per-run cap — a run can hold at most one LIVE claim, so a clean run.end
// terminalizes exactly the task it was working (never mass-completes unrelated tasks).
describe('claimTask one-claim-per-run cap', () => {
  it('a run holding a live claim cannot claim a second task (ConflictError)', async () => {
    const r = await mkRun();
    const a = await addTask(projectId, 'A');
    const b = await addTask(projectId, 'B');
    await claimTask(a.id, r.id);
    await expect(claimTask(b.id, r.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('after terminalize clears the prior claim, the run can claim a new task', async () => {
    // Proves the cap tracks LIVE pointers, not run lifetime: once A's claim is cleared the cap releases.
    const r = await mkRun();
    const a = await addTask(projectId, 'A');
    const b = await addTask(projectId, 'B');
    await claimTask(a.id, r.id);
    await recordRunEnd(r.id, 'completed'); // A → done, r's claim pointer cleared
    expect((await claimTask(b.id, r.id))?.claimedByRunId).toBe(r.id);
  });

  // THE documented self-dispatch loop, all within ONE still-running session/run: claim A → finish A via
  // set-status done → claim B. set-status done does NOT clear A's claim pointer (it lingers live for up to
  // CLAIM_TTL_SEC), so the cap must exclude DONE tasks or it wedges this loop for ~30 min. Regression guard
  // for the high-sev bug the adversarial review caught (the `t2.status <> 'done'` term in the cap).
  it('a run that FINISHED its task via set-status done can still claim the next (multi-task loop)', async () => {
    const r = await mkRun();
    const a = await addTask(projectId, 'A');
    const b = await addTask(projectId, 'B');
    await claimTask(a.id, r.id);
    await setTaskStatus(a.id, 'done'); // finish A in-session; A's claim pointer lingers (NOT cleared here)
    expect((await claimTask(b.id, r.id))?.claimedByRunId).toBe(r.id); // cap must not count done-A
  });

  // The cap still blocks the genuine hazard: holding a second UNFINISHED claim (in_progress here).
  it('a run with an in_progress (unfinished) claim cannot claim a second task', async () => {
    const r = await mkRun();
    const a = await addTask(projectId, 'A');
    const b = await addTask(projectId, 'B');
    await claimTask(a.id, r.id);
    await setTaskStatus(a.id, 'in_progress');
    await expect(claimTask(b.id, r.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it('the cap does not apply to manual (null-run) claims', async () => {
    const a = await addTask(projectId, 'A');
    const b = await addTask(projectId, 'B');
    await claimTask(a.id, null);
    expect((await claimTask(b.id, null))?.claimedByRunId).toBeNull(); // both manual claims allowed
  });

  it('the cap is per-run: distinct runs each claim distinct tasks', async () => {
    const r1 = await mkRun();
    const r2 = await mkRun();
    const a = await addTask(projectId, 'A');
    const b = await addTask(projectId, 'B');
    await claimTask(a.id, r1.id);
    expect((await claimTask(b.id, r2.id))?.claimedByRunId).toBe(r2.id);
  });
});

describe('getNextClaimableTask', () => {
  it('does not serve a live-claimed task', async () => {
    const r = await mkRun();
    const t = await addTask(projectId, 'A');
    await claimTask(t.id, r.id);
    expect(await getNextClaimableTask({ projectId })).toBeNull();
  });

  it('serves a task whose claim has expired', async () => {
    const r = await mkRun();
    const t = await addTask(projectId, 'A');
    await claimTask(t.id, r.id, -10);
    expect((await getNextClaimableTask({ projectId }))?.id).toBe(t.id);
  });
});

describe('recordRunEnd terminalization', () => {
  it('a completed run marks its claimed task done, clears the claim, and stops re-serving it', async () => {
    const r = await mkRun();
    const t = await addTask(projectId, 'A');
    await claimTask(t.id, r.id);
    await recordRunEnd(r.id, 'completed');
    const after = await getTaskById(t.id);
    expect(after?.status).toBe('done');
    expect(after?.claimedByRunId).toBeNull();
    expect(after?.completedAt).toBeTruthy();
    expect(await getNextClaimableTask({ projectId })).toBeNull();
  });

  it('a re-sent completed run.end is idempotent', async () => {
    const r = await mkRun();
    const t = await addTask(projectId, 'A');
    await claimTask(t.id, r.id);
    await recordRunEnd(r.id, 'completed');
    await recordRunEnd(r.id, 'completed');
    expect((await getTaskById(t.id))?.status).toBe('done');
  });

  it('a failed run releases a todo claimed task back to the queue', async () => {
    const r = await mkRun();
    const t = await addTask(projectId, 'A');
    await claimTask(t.id, r.id);
    await recordRunEnd(r.id, 'failed');
    const after = await getTaskById(t.id);
    expect(after?.status).toBe('todo');
    expect(after?.claimedByRunId).toBeNull();
    expect((await getNextClaimableTask({ projectId }))?.id).toBe(t.id);
  });

  // Regression guard for the in_progress strand (PR #11): a failed run must reset in_progress → todo,
  // or the task is invisible to the queue forever.
  it('a failed run resets an in_progress claimed task to todo (strand regression)', async () => {
    const r = await mkRun();
    const t = await addTask(projectId, 'A');
    await claimTask(t.id, r.id);
    await setTaskStatus(t.id, 'in_progress');
    await recordRunEnd(r.id, 'failed');
    const after = await getTaskById(t.id);
    expect(after?.status).toBe('todo');
    expect(after?.claimedByRunId).toBeNull();
    expect((await getNextClaimableTask({ projectId }))?.id).toBe(t.id);
  });
});

describe('reapStaleRuns', () => {
  it('abandons a stale run and releases its claim, resetting in_progress → todo', async () => {
    const r = await mkRun();
    const t = await addTask(projectId, 'A');
    await claimTask(t.id, r.id);
    await setTaskStatus(t.id, 'in_progress');
    // backdate the heartbeat well past the stale window so the reaper picks it up
    await db.update(runs).set({ lastHeartbeatAt: sql`now() - interval '1 hour'` }).where(eq(runs.id, r.id));
    const reaped = await reapStaleRuns();
    expect(reaped.some((x) => x.id === r.id)).toBe(true);
    const after = await getTaskById(t.id);
    expect(after?.status).toBe('todo');
    expect(after?.claimedByRunId).toBeNull();
    expect((await getNextClaimableTask({ projectId }))?.id).toBe(t.id);
  });
});

// Edge 3: completed-run reaper backstop — recordRunEnd writes the run's terminal status and terminalizes
// its claims in SEPARATE statements (no neon-http txn); a gap between them leaves a dangling claim that
// reconcileTerminalClaims() sweeps on the reaper tick by replaying terminalize.
describe('reconcileTerminalClaims (terminalize backstop)', () => {
  it('completes a dangling claim of a completed run', async () => {
    const r = await mkRun();
    const t = await addTask(projectId, 'A');
    await claimTask(t.id, r.id);
    // Simulate recordRunEnd's status write landing but its terminalize NOT running (the non-atomic gap):
    await db.update(runs).set({ status: 'completed', endedAt: new Date() }).where(eq(runs.id, r.id));
    const reconciled = await reconcileTerminalClaims();
    expect(reconciled.some((x) => x.runId === r.id)).toBe(true);
    const after = await getTaskById(t.id);
    expect(after?.status).toBe('done');
    expect(after?.claimedByRunId).toBeNull();
    expect(after?.completedAt).toBeTruthy();
  });

  it('releases a dangling claim of a failed run back to the queue', async () => {
    const r = await mkRun();
    const t = await addTask(projectId, 'A');
    await claimTask(t.id, r.id);
    await db.update(runs).set({ status: 'failed', endedAt: new Date() }).where(eq(runs.id, r.id));
    await reconcileTerminalClaims();
    const after = await getTaskById(t.id);
    expect(after?.status).toBe('todo');
    expect(after?.claimedByRunId).toBeNull();
    expect((await getNextClaimableTask({ projectId }))?.id).toBe(t.id);
  });

  it('leaves a cleanly-terminalized run alone (no dangling claim → no-op)', async () => {
    const r = await mkRun();
    const t = await addTask(projectId, 'A');
    await claimTask(t.id, r.id);
    await recordRunEnd(r.id, 'completed'); // clean: terminalize ran inline, claim already cleared
    const reconciled = await reconcileTerminalClaims();
    expect(reconciled.some((x) => x.runId === r.id)).toBe(false);
    expect((await getTaskById(t.id))?.status).toBe('done'); // unchanged
  });
});

describe('getRecentRuns attribution', () => {
  it('a live run carries its currently-claimed task', async () => {
    const r = await mkRun();
    const t = await addTask(projectId, 'A');
    await claimTask(t.id, r.id);
    const row = (await getRecentRuns({ active: true, limit: 100 })).find((x) => x.id === r.id);
    expect(row?.claimedTask?.id).toBe(t.id);
    expect(row?.claimedTask?.label).toBe('A');
  });
});

describe('importTasks', () => {
  it('bulk-inserts and dedups on (project, label), returning only new rows', async () => {
    const first = await importTasks(projectId, [
      { label: '#1 alpha', notes: 'https://github.com/o/r/issues/1' },
      { label: '#2 beta', notes: 'https://github.com/o/r/issues/2' },
    ]);
    expect(first).toHaveLength(2);
    const second = await importTasks(projectId, [
      { label: '#1 alpha', notes: 'https://github.com/o/r/issues/1' }, // dup → skipped
      { label: '#3 gamma', notes: 'https://github.com/o/r/issues/3' }, // new
    ]);
    expect(second).toHaveLength(1);
    expect(second[0].label).toBe('#3 gamma');
  });
});

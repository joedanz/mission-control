// ABOUTME: Tests the recordRunEnd cancel-guard (auto-claim daemon prerequisite). A run the operator
// ABOUTME: cancelled must NOT auto-complete its claimed work: recordRunEnd('completed') on a cancel_requested
// ABOUTME: run records 'abandoned' so terminalizeClaimsForRun RELEASES the claim back to todo instead of
// ABOUTME: marking unfinished work done. Real Neon DB; the guard is the load-bearing safety for unattended runs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, runs, events } from '../lib/db/schema';
import { createProject, addTask, recordRunStart, claimTask, setRunCancelRequested, recordRunEnd } from '../lib/mutations';
import { getTaskById } from '../lib/queries';

describe('recordRunEnd cancel-guard', () => {
  let projectId: string;
  let runIds: string[];

  beforeEach(async () => {
    runIds = [];
    const p = await createProject({
      name: `vitest-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  it('completed + cancel_requested → run recorded ABANDONED and the claim is RELEASED (todo), not done', async () => {
    const task = await addTask(projectId, 'cancelled-mid-flight task');
    const run = await recordRunStart({ agentLabel: 'vitest-guard', projectId });
    runIds.push(run.id);

    expect(await claimTask(task.id, run.id)).toBeTruthy();
    await setRunCancelRequested(run.id);

    const ended = await recordRunEnd(run.id, 'completed'); // caller says completed, but it was cancelled
    expect(ended?.status).toBe('abandoned'); // guard coerced completed → abandoned

    const t = await getTaskById(task.id);
    expect(t?.status).toBe('todo'); // RELEASED back to the queue, NOT marked done
    expect(t?.claimedByRunId).toBeNull(); // claim cleared
  });

  it('completed WITHOUT cancel → run completed and the claimed task is marked DONE (control)', async () => {
    const task = await addTask(projectId, 'clean-completion task');
    const run = await recordRunStart({ agentLabel: 'vitest-guard', projectId });
    runIds.push(run.id);

    await claimTask(task.id, run.id);
    const ended = await recordRunEnd(run.id, 'completed');
    expect(ended?.status).toBe('completed'); // no cancel → passes through

    const t = await getTaskById(task.id);
    expect(t?.status).toBe('done'); // auto-completed on clean stop
  });

  it('is idempotent under re-post: a second completed run.end on a cancelled run stays abandoned + released', async () => {
    const task = await addTask(projectId, 're-post task');
    const run = await recordRunStart({ agentLabel: 'vitest-guard', projectId });
    runIds.push(run.id);

    await claimTask(task.id, run.id);
    await setRunCancelRequested(run.id);
    await recordRunEnd(run.id, 'completed'); // daemon ends it
    const second = await recordRunEnd(run.id, 'completed'); // the child's Stop hook re-posts
    expect(second?.status).toBe('abandoned'); // guard holds on the re-post (cancel_requested still true)

    const t = await getTaskById(task.id);
    expect(t?.status).toBe('todo'); // never flips to done
  });
});

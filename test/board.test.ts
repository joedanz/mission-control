// ABOUTME: Integration tests for the Kanban board write path (moveTask) + queue ordering, against a real
// ABOUTME: Neon dev DB. Covers status change, sortOrder reindex, version guard, live-claim refusal, and
// ABOUTME: claim-clear-on-release. Tests share one DB and run serially (vitest fileParallelism:false).

import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db/index';
import { projects, events } from '@/lib/db/schema';
import { createProject, addTask, moveTask, claimTask, recordRunStart } from '@/lib/mutations';
import { getNextClaimableTask, getTaskById } from '@/lib/queries';

const createdProjectIds: string[] = [];

async function freshProject(name: string) {
  const p = await createProject({ name, category: 'internal', status: 'active' });
  createdProjectIds.push(p.id);
  return p;
}

function uniqueName(prefix: string) {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function statusEventCount(taskId: string) {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.taskId, taskId), eq(events.type, 'task.status_changed')));
  return rows.length;
}

afterAll(async () => {
  if (createdProjectIds.length) {
    await db.delete(projects).where(inArray(projects.id, createdProjectIds));
  }
});

describe('moveTask — status changes', () => {
  it('changes status, bumps version, logs a status_changed event, and manages completedAt', async () => {
    const p = await freshProject(uniqueName('board-status'));
    const t = await addTask(p.id, 'ship it');

    const inProg = await moveTask(t.id, { toStatus: 'in_progress' });
    expect(inProg).not.toBeNull();
    expect(inProg!.status).toBe('in_progress');
    expect(inProg!.version).toBe(t.version + 1);
    expect(inProg!.completedAt).toBeNull();

    const done = await moveTask(t.id, { toStatus: 'done' });
    expect(done!.status).toBe('done');
    expect(done!.completedAt).not.toBeNull();

    const back = await moveTask(t.id, { toStatus: 'todo' });
    expect(back!.status).toBe('todo');
    expect(back!.completedAt).toBeNull();

    expect(await statusEventCount(t.id)).toBe(3);
  });

  it('is a no-op (no status write, no event) when toStatus equals current status', async () => {
    const p = await freshProject(uniqueName('board-noop'));
    const t = await addTask(p.id, 'already todo');
    const before = await statusEventCount(t.id);
    const res = await moveTask(t.id, { toStatus: 'todo' });
    expect(res!.version).toBe(t.version); // no bump
    expect(await statusEventCount(t.id)).toBe(before);
  });

  it('returns null on a version mismatch and leaves the task unchanged', async () => {
    const p = await freshProject(uniqueName('board-version'));
    const t = await addTask(p.id, 'guarded');
    const res = await moveTask(t.id, { toStatus: 'done', expectedVersion: 999 });
    expect(res).toBeNull();
    const after = await getTaskById(t.id);
    expect(after!.status).toBe('todo');
    expect(after!.version).toBe(t.version);
  });
});

describe('moveTask — reorder', () => {
  it('reindexes sortOrder without a status event or project touch', async () => {
    const p = await freshProject(uniqueName('board-reorder'));
    const a = await addTask(p.id, 'a');
    const b = await addTask(p.id, 'b');
    const beforeEvents = await statusEventCount(a.id);
    const projBefore = (await db.select().from(projects).where(eq(projects.id, p.id)))[0];

    const res = await moveTask(a.id, { orderedIds: [b.id, a.id] });
    expect(res).not.toBeNull();

    const aAfter = await getTaskById(a.id);
    const bAfter = await getTaskById(b.id);
    expect(bAfter!.sortOrder).toBe(0);
    expect(aAfter!.sortOrder).toBe(1);
    expect(aAfter!.version).toBe(a.version); // reorder does not bump version
    expect(await statusEventCount(a.id)).toBe(beforeEvents); // silent

    const projAfter = (await db.select().from(projects).where(eq(projects.id, p.id)))[0];
    expect(projAfter.lastActivityAt.getTime()).toBe(projBefore.lastActivityAt.getTime());
  });

  it('scopes the reindex to the task own project', async () => {
    const p1 = await freshProject(uniqueName('board-scope-1'));
    const p2 = await freshProject(uniqueName('board-scope-2'));
    const a = await addTask(p1.id, 'a');
    const b = await addTask(p1.id, 'b');
    const c = await addTask(p2.id, 'c'); // foreign task, sortOrder 0

    // Maliciously include c.id from another project; it must NOT be reindexed.
    await moveTask(a.id, { orderedIds: [b.id, a.id, c.id] });
    const cAfter = await getTaskById(c.id);
    expect(cAfter!.sortOrder).toBe(c.sortOrder);
  });
});

describe('moveTask — claim policy', () => {
  it('refuses to move a live-claimed task', async () => {
    const p = await freshProject(uniqueName('board-liveclaim'));
    const t = await addTask(p.id, 'claimed');
    const run = await recordRunStart({ agentLabel: 'claude-code' });
    await claimTask(t.id, run.id); // default TTL → live claim

    const res = await moveTask(t.id, { toStatus: 'in_progress' });
    expect(res).toBeNull();
    const after = await getTaskById(t.id);
    expect(after!.status).toBe('todo');
  });

  it('clears claim columns when moving a task out of in_progress', async () => {
    const p = await freshProject(uniqueName('board-release'));
    const t = await addTask(p.id, 'release me');
    const run = await recordRunStart({ agentLabel: 'claude-code' });
    await claimTask(t.id, run.id, -1); // expired claim → columns set but not live

    const ip = await moveTask(t.id, { toStatus: 'in_progress' });
    expect(ip!.status).toBe('in_progress');
    expect(ip!.claimedByRunId).toBe(run.id); // not cleared on entry

    const back = await moveTask(t.id, { toStatus: 'todo' });
    expect(back!.status).toBe('todo');
    expect(back!.claimedByRunId).toBeNull();
    expect(back!.claimExpiresAt).toBeNull();
    expect(back!.claimedAt).toBeNull();
  });

});

describe('getNextClaimableTask — sortOrder steers the queue', () => {
  it('returns the lowest-sortOrder todo task, overriding createdAt order', async () => {
    const p = await freshProject(uniqueName('board-queue'));
    const first = await addTask(p.id, 'created first');
    const second = await addTask(p.id, 'created second');

    // Default sortOrder ties → FIFO returns the one created first.
    expect((await getNextClaimableTask({ projectId: p.id }))!.id).toBe(first.id);

    // Reorder so the second-created task is on top → it becomes the queue head.
    await moveTask(second.id, { orderedIds: [second.id, first.id] });
    expect((await getNextClaimableTask({ projectId: p.id }))!.id).toBe(second.id);
  });
});

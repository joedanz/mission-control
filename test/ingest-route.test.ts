// ABOUTME: Integration tests for POST /api/ingest — the ONLY unauthenticated prod write surface (bearer-token
// ABOUTME: auth only). Drives the real route handler via a constructed Request and asserts DB effects. Covers
// ABOUTME: the auth gate (incl. the security property: a rejected request writes nothing), body/dispatch
// ABOUTME: validation, and the four write paths (run.start idempotency, heartbeat GREATEST guard + status gate,
// ABOUTME: run.end terminalization + claim loop-closure, event dedup/attribution).
//
// Safe to import the ingest route directly: it's framework-agnostic (pure mutations/queries/actor-context, no
// 'server-only' / next/headers). Runs against the real Neon instance (DATABASE_URL), serially
// (vitest fileParallelism:false). Each test scopes to a throwaway project + client-supplied run ids for cleanup.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { POST } from '../app/api/ingest/route';
import { db } from '../lib/db/index';
import { projects, runs, events } from '../lib/db/schema';
import { createProject, addTask, claimTask, setProjectRepo, setRunCancelRequested } from '../lib/mutations';
import { getRunById, getEvents, getTaskById } from '../lib/queries';

const ENDPOINT = 'http://localhost/api/ingest';

let projectId: string;
let runIds: string[];
let tag: string; // unique agent label per test, for unambiguous event attribution assertions

beforeEach(async () => {
  runIds = [];
  tag = `ingest-vitest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const p = await createProject({ name: tag, category: 'internal', status: 'prelaunch' });
  projectId = p.id;
});

afterEach(async () => {
  // Clean events by project AND by tracked run: a null-projectId event would survive the first filter, then
  // get orphaned (runId → SET NULL) when its run is deleted. Clear both before the runs go.
  await db.delete(events).where(eq(events.projectId, projectId));
  if (runIds.length) {
    await db.delete(events).where(inArray(events.runId, runIds));
    await db.delete(runs).where(inArray(runs.id, runIds));
  }
  await db.delete(projects).where(eq(projects.id, projectId)); // cascades tasks
});

/** POST a body to the real ingest handler. Default auth is a valid bearer; pass { auth: null } for no header
 *  or { auth: 'Bearer wrong' } for a bad one. A string body is sent verbatim (to exercise malformed JSON). */
async function ingest(
  body: unknown,
  opts: { auth?: string | null } = {},
): Promise<{ status: number; json: { ok: boolean; data?: unknown; error?: { code: string; message: string } } }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const auth = 'auth' in opts ? opts.auth : `Bearer ${process.env.INGEST_TOKEN}`;
  if (auth) headers.Authorization = auth;
  const req = new Request(ENDPOINT, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, json: await res.json() };
}

/** Open a run through the route (black-box) and track it for cleanup. Returns the client-supplied id. */
async function startRun(extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  runIds.push(id);
  const { status } = await ingest({ type: 'run.start', id, projectId, agentLabel: tag, ...extra });
  expect(status).toBe(200);
  return id;
}

describe('POST /api/ingest — auth gate', () => {
  it('accepts a correct bearer token', async () => {
    const { status, json } = await ingest({ type: 'run.start', id: (() => { const i = randomUUID(); runIds.push(i); return i; })(), projectId, agentLabel: tag });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it('a rejected request performs NO write — an unauthenticated run.end leaves a live run untouched (the security property)', async () => {
    const id = await startRun(); // a real running run, written with a valid token
    expect((await getRunById(id))!.status).toBe('running');
    // Fire a MUTATING call (run.end terminates a run) with no token. If auth were checked after the body were
    // parsed, this would flip the run terminal; a correct gate rejects before recordRunEnd ever runs.
    const { status, json } = await ingest({ type: 'run.end', id, status: 'completed' }, { auth: null });
    expect(status).toBe(401);
    expect(json.error?.code).toBe('UNAUTHORIZED');
    const after = await getRunById(id);
    expect(after!.status).toBe('running'); // unchanged — the rejected request never reached the mutation
    expect(after!.endedAt).toBeNull();
  });

  it('rejects a wrong token with 401', async () => {
    const { status, json } = await ingest({ type: 'run.start', id: randomUUID() }, { auth: 'Bearer not-the-token' });
    expect(status).toBe(401);
    expect(json.error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects when INGEST_TOKEN is unset server-side', async () => {
    const saved = process.env.INGEST_TOKEN;
    delete process.env.INGEST_TOKEN;
    try {
      const { status } = await ingest({ type: 'run.start', id: randomUUID() }, { auth: 'Bearer anything' });
      expect(status).toBe(401);
    } finally {
      process.env.INGEST_TOKEN = saved; // restore for the rest of the serial suite
    }
  });
});

describe('POST /api/ingest — body & dispatch validation', () => {
  it('rejects a malformed JSON body with 400', async () => {
    const { status, json } = await ingest('{ not json', {});
    expect(status).toBe(400);
    expect(json.error?.code).toBe('BAD_REQUEST');
  });

  it('rejects an unknown type with 400', async () => {
    const { status, json } = await ingest({ type: 'run.explode' });
    expect(status).toBe(400);
    expect(json.error?.message).toContain('unknown type');
  });

  it('rejects a missing type with 400', async () => {
    const { status } = await ingest({});
    expect(status).toBe(400);
  });

  it('run.heartbeat without id → 400 "id required"', async () => {
    const { status, json } = await ingest({ type: 'run.heartbeat' });
    expect(status).toBe(400);
    expect(json.error?.message).toBe('id required');
  });

  it('run.end without id → 400 "id required"', async () => {
    const { status } = await ingest({ type: 'run.end' });
    expect(status).toBe(400);
  });

  it('event without summary → 400 "summary required"', async () => {
    const { status, json } = await ingest({ type: 'event' });
    expect(status).toBe(400);
    expect(json.error?.message).toBe('summary required');
  });
});

describe('POST /api/ingest — run.start', () => {
  it('creates a running run and logs a run.started event attributed to the actor', async () => {
    const id = await startRun({ title: 'ingest test' });
    const run = await getRunById(id);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('running');
    expect(run!.projectId).toBe(projectId);
    const started = (await getEvents({ runId: id })).filter((e) => e.type === 'run.started');
    expect(started).toHaveLength(1);
    expect(started[0].actorLabel).toBe(tag); // withActor({label: agentLabel}) attribution
  });

  it('is idempotent on a repeated id (one run, one deduped run.started event)', async () => {
    const id = randomUUID();
    runIds.push(id);
    await ingest({ type: 'run.start', id, projectId, agentLabel: tag });
    await ingest({ type: 'run.start', id, projectId, agentLabel: tag }); // retried start
    const rows = await db.select().from(runs).where(eq(runs.id, id));
    expect(rows).toHaveLength(1);
    const started = (await getEvents({ runId: id })).filter((e) => e.type === 'run.started');
    expect(started).toHaveLength(1); // deduped...
    expect(started[0].idempotencyKey).toBe(`run.started:${id}`); // ...via this exact key, not by coincidence
  });

  it('resolves projectId from workDir when projectId is omitted (the SessionStart-hook path)', async () => {
    const repoPath = `/tmp/ingest-vitest-${tag}`;
    await setProjectRepo(projectId, repoPath, null);
    const id = randomUUID();
    runIds.push(id);
    const { status } = await ingest({ type: 'run.start', id, workDir: repoPath, agentLabel: tag }); // no projectId
    expect(status).toBe(200);
    expect((await getRunById(id))!.projectId).toBe(projectId); // auto-looked-up via getProjectIdByRepoPath
  });

  it('surfaces a mutation failure as 500 DB (run.start with a nonexistent projectId FK)', async () => {
    // A projectId that references no row violates the runs→projects FK on INSERT (no row is written).
    const { status, json } = await ingest({ type: 'run.start', id: randomUUID(), projectId: randomUUID(), agentLabel: tag });
    expect(status).toBe(500);
    expect(json.error?.code).toBe('DB'); // the violation is caught + reported, not an unhandled crash
  });
});

describe('POST /api/ingest — run.heartbeat', () => {
  it('applies the GREATEST monotonic guard (a lower total never regresses)', async () => {
    const id = await startRun();
    await ingest({ type: 'run.heartbeat', id, tokensIn: 100 });
    expect((await getRunById(id))!.tokensIn).toBe(100);
    await ingest({ type: 'run.heartbeat', id, tokensIn: 50 }); // out-of-order / regression
    expect((await getRunById(id))!.tokensIn).toBe(100);
    await ingest({ type: 'run.heartbeat', id, tokensIn: 150 }); // genuine increase
    expect((await getRunById(id))!.tokensIn).toBe(150);
  });

  it('applies the GREATEST guard to costMicros — the authoritative spend input never regresses', async () => {
    // costMicros is what getSpendRollup sums, so a regression here silently corrupts every spend report.
    // The guard was only ever exercised via tokensIn; this pins it on the field the rollup actually reads.
    const id = await startRun();
    await ingest({ type: 'run.heartbeat', id, costMicros: 1_000_000 });
    expect((await getRunById(id))!.costMicros).toBe(1_000_000);
    await ingest({ type: 'run.heartbeat', id, costMicros: 500_000 }); // out-of-order / lower cumulative → must hold
    expect((await getRunById(id))!.costMicros).toBe(1_000_000);
    await ingest({ type: 'run.heartbeat', id, costMicros: 1_500_000 }); // genuine increase → rises
    expect((await getRunById(id))!.costMicros).toBe(1_500_000);
  });

  it('guards every cumulative metric independently in one heartbeat (not just tokensIn)', async () => {
    // The GREATEST guard covers five columns; prove tokensOut/cacheRead/cacheWrite/costMicros all hold under a
    // combined regression, so a future change that wired the guard to only some of them would fail here.
    const id = await startRun();
    await ingest({ type: 'run.heartbeat', id, tokensOut: 200, cacheReadTokens: 300, cacheWriteTokens: 400, costMicros: 9_000 });
    const hi = (await getRunById(id))!;
    expect([hi.tokensOut, hi.cacheReadTokens, hi.cacheWriteTokens, hi.costMicros]).toEqual([200, 300, 400, 9_000]);
    await ingest({ type: 'run.heartbeat', id, tokensOut: 1, cacheReadTokens: 1, cacheWriteTokens: 1, costMicros: 1 }); // all lower
    const held = (await getRunById(id))!;
    expect([held.tokensOut, held.cacheReadTokens, held.cacheWriteTokens, held.costMicros]).toEqual([200, 300, 400, 9_000]);
  });

  it('ignores a heartbeat on a terminal run (status-gated → data null, totals untouched)', async () => {
    const id = await startRun();
    await ingest({ type: 'run.heartbeat', id, tokensIn: 50 }); // a real total on the still-running run
    expect((await getRunById(id))!.tokensIn).toBe(50);
    await ingest({ type: 'run.end', id, status: 'completed' });
    const { status, json } = await ingest({ type: 'run.heartbeat', id, tokensIn: 999 });
    expect(status).toBe(200);
    expect(json.data).toBeNull();
    expect((await getRunById(id))!.tokensIn).toBe(50); // 999 not applied — proves rejection, not just the default 0
  });

  it('returns data null (200) for a heartbeat on a run that never existed', async () => {
    const { status, json } = await ingest({ type: 'run.heartbeat', id: randomUUID(), tokensIn: 5 });
    expect(status).toBe(200);
    expect(json.data).toBeNull(); // phantom run (lost run.start) → no-op, not an error
  });

  it('coerces away a non-numeric metric (numOrU) instead of writing garbage', async () => {
    const id = await startRun();
    await ingest({ type: 'run.heartbeat', id, tokensIn: 'lots' }); // non-number → undefined → omitted from SET
    expect((await getRunById(id))!.tokensIn).toBe(0);
  });

  it('round-trips cancelRequested in the heartbeat ENVELOPE — the exact bit the kill-switch hook caches', async () => {
    // The PostToolUse hook reads json.data.cancelRequested off this response (not the mutation return), so a
    // route change that narrowed `data` would silently disable enforcement while every other test stays green.
    const id = await startRun();
    const before = await ingest({ type: 'run.heartbeat', id });
    expect((before.json.data as { cancelRequested: boolean }).cancelRequested).toBe(false);
    await setRunCancelRequested(id);
    const after = await ingest({ type: 'run.heartbeat', id });
    expect((after.json.data as { cancelRequested: boolean }).cancelRequested).toBe(true);
  });
});

describe('POST /api/ingest — run.end', () => {
  it('marks the run terminal (endedAt set) and logs a run.ended event', async () => {
    const id = await startRun();
    const { json } = await ingest({ type: 'run.end', id, status: 'failed' });
    expect((json.data as { status: string }).status).toBe('failed');
    const run = await getRunById(id);
    expect(run!.status).toBe('failed');
    expect(run!.endedAt).not.toBeNull();
    const ended = (await getEvents({ runId: id })).filter((e) => e.type === 'run.ended');
    expect(ended).toHaveLength(1);
  });

  it('returns data null (200) for run.end on a run that never existed', async () => {
    const { status, json } = await ingest({ type: 'run.end', id: randomUUID(), status: 'completed' });
    expect(status).toBe(200);
    expect(json.data).toBeNull();
  });

  it('completed run closes the claim loop (claimed custom task → done, claim cleared)', async () => {
    const id = await startRun();
    const task = await addTask(projectId, `${tag}-loop`);
    await claimTask(task.id, id);
    await ingest({ type: 'run.end', id, status: 'completed' });
    const t = await getTaskById(task.id);
    expect(t!.status).toBe('done');
    expect(t!.claimedByRunId).toBeNull();
  });

  it('failed run releases the claim back to the queue (claim cleared)', async () => {
    const id = await startRun();
    const task = await addTask(projectId, `${tag}-release`);
    await claimTask(task.id, id);
    await ingest({ type: 'run.end', id, status: 'failed' });
    const t = await getTaskById(task.id);
    expect(t!.claimedByRunId).toBeNull(); // released, not completed
    expect(t!.status).toBe('todo');
  });

  it('coerces an unknown status to completed (inEnum fallback runs the completed branch)', async () => {
    const id = await startRun();
    const task = await addTask(projectId, `${tag}-coerce`);
    await claimTask(task.id, id);
    const { json } = await ingest({ type: 'run.end', id, status: 'bogus' });
    expect((json.data as { status: string }).status).toBe('completed');
    expect((await getTaskById(task.id))!.status).toBe('done'); // proves the coerced status drove terminalization
  });
});

describe('POST /api/ingest — event', () => {
  it('appends a log entry readable by run AND project, with the right level + actor', async () => {
    const id = await startRun();
    const summary = `hello ${randomUUID()}`;
    const { status } = await ingest({
      type: 'event', eventType: 'note', summary, level: 'warn', runId: id, projectId, agentLabel: tag,
    });
    expect(status).toBe(200);
    const ev = (await getEvents({ runId: id })).find((e) => e.summary === summary);
    expect(ev).toBeDefined();
    expect(ev!.level).toBe('warn');
    expect(ev!.actorLabel).toBe(tag);
    expect((await getEvents({ projectId })).some((e) => e.id === ev!.id)).toBe(true);
  });

  it('coerces an unknown eventType to note (inEnum fallback)', async () => {
    const { json } = await ingest({ type: 'event', eventType: 'not.a.real.type', summary: 'x', projectId, agentLabel: tag });
    expect((json.data as { type: string }).type).toBe('note');
  });

  it('coerces an unknown level to info (inEnum fallback)', async () => {
    const { json } = await ingest({ type: 'event', summary: 'lvl', level: 'screaming', projectId, agentLabel: tag });
    expect((json.data as { level: string }).level).toBe('info');
  });

  it('dedups on idempotencyKey (retry returns the SAME row, 200, one row total)', async () => {
    const key = `ingest-test-${randomUUID()}`;
    const first = await ingest({ type: 'event', summary: 'dup', projectId, idempotencyKey: key, agentLabel: tag });
    const second = await ingest({ type: 'event', summary: 'dup', projectId, idempotencyKey: key, agentLabel: tag }); // retry
    expect(second.status).toBe(200); // a duplicate append is retry-safe, not an error
    expect((second.json.data as { id: string }).id).toBe((first.json.data as { id: string }).id); // same row echoed back
    const matches = (await getEvents({ projectId })).filter((e) => e.idempotencyKey === key);
    expect(matches).toHaveLength(1);
  });
});

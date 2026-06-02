// ABOUTME: Tests for getSpendRollup — the first DB-side GROUP BY in the repo. Pins the grouping axes
// ABOUTME: (project/agent/day/run), the windowed/scoped filters, limit+truncation, and that SUM stays numeric.
//
// Runs against the real Neon instance (DATABASE_URL), serially (vitest fileParallelism:false). Each test
// scopes its assertions to throwaway fixtures (two fresh projects + a unique agent label) so it is
// deterministic even though the rollup query is global.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, runs } from '../lib/db/schema';
import { createProject, recordRunStart } from '../lib/mutations';
import { getSpendRollup } from '../lib/queries';

let projectA: string;
let projectB: string;
let runIds: string[];
let tag: string; // unique agent label tying this test's runs together

beforeEach(async () => {
  runIds = [];
  tag = `spend-vitest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const a = await createProject({ name: `${tag}-A`, category: 'internal', status: 'prelaunch' });
  const b = await createProject({ name: `${tag}-B`, category: 'internal', status: 'prelaunch' });
  projectA = a.id;
  projectB = b.id;
});

afterEach(async () => {
  if (runIds.length) await db.delete(runs).where(inArray(runs.id, runIds));
  await db.delete(projects).where(inArray(projects.id, [projectA, projectB]));
});

/** Seed a run with a fixed cost/tokens/agent/start time. recordRunStart then a direct update (test
 *  fixture only) so we control every dimension the rollup groups on. */
async function mkRun(opts: {
  projectId?: string | null;
  agent?: string;
  costMicros?: number;
  tokensIn?: number;
  startedAt?: Date;
}) {
  const agentLabel = opts.agent ?? tag;
  const r = await recordRunStart({ agentLabel, projectId: opts.projectId ?? null });
  runIds.push(r.id);
  await db
    .update(runs)
    .set({
      agentLabel,
      costMicros: opts.costMicros ?? 0,
      tokensIn: opts.tokensIn ?? 0,
      ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
    })
    .where(eq(runs.id, r.id));
  return r;
}

describe('getSpendRollup', () => {
  it('groups by project, summing runs.costMicros; LEFT JOIN keeps unassigned runs', async () => {
    await mkRun({ projectId: projectA, costMicros: 1_000_000, tokensIn: 100 });
    await mkRun({ projectId: projectA, costMicros: 500_000, tokensIn: 50 });
    await mkRun({ projectId: projectB, costMicros: 2_000_000, tokensIn: 200 });
    await mkRun({ projectId: null, costMicros: 250_000, tokensIn: 25 });

    const r = await getSpendRollup({ groupBy: 'project', agentLabel: tag });

    expect(r.totals.costMicros).toBe(3_750_000);
    expect(r.totals.runCount).toBe(4);
    expect(r.totals.tokensIn).toBe(375); // token sums roll up too
    // spend-desc: projectB (2.0) leads
    expect(r.rows[0].label).toBe(`${tag}-B`);
    expect(r.rows[0].costMicros).toBe(2_000_000);
    // projectA's two runs collapse into one bucket
    expect(r.rows.find((x) => x.label === `${tag}-A`)?.costMicros).toBe(1_500_000);
    // the null-project run survives under the synthetic bucket (not dropped by the join)
    expect(r.rows.find((x) => x.label === '(unassigned)')?.costMicros).toBe(250_000);
    // SUM(bigint) came back coerced to a JS number, not a string
    expect(typeof r.rows[0].costMicros).toBe('number');
  });

  it('groups by agent within a project scope', async () => {
    await mkRun({ projectId: projectA, agent: `${tag}-x`, costMicros: 1_000_000 });
    await mkRun({ projectId: projectA, agent: `${tag}-x`, costMicros: 1_000_000 });
    await mkRun({ projectId: projectA, agent: `${tag}-y`, costMicros: 3_000_000 });

    const r = await getSpendRollup({ groupBy: 'agent', projectId: projectA });

    expect(r.rows.length).toBe(2);
    expect(r.rows[0].label).toBe(`${tag}-y`); // top spend first
    expect(r.rows[0].costMicros).toBe(3_000_000);
    const x = r.rows.find((row) => row.label === `${tag}-x`);
    expect(x?.costMicros).toBe(2_000_000);
    expect(x?.runCount).toBe(2);
  });

  it('groups by day (date-desc) and respects the since/until window', async () => {
    await mkRun({ projectId: projectA, costMicros: 1_000_000, startedAt: new Date('2026-03-01T12:00:00Z') });
    await mkRun({ projectId: projectA, costMicros: 2_000_000, startedAt: new Date('2026-03-02T12:00:00Z') });
    await mkRun({ projectId: projectA, costMicros: 9_000_000, startedAt: new Date('2026-03-05T12:00:00Z') });

    const r = await getSpendRollup({
      groupBy: 'day',
      projectId: projectA,
      since: new Date('2026-03-01T00:00:00Z'),
      until: new Date('2026-03-03T00:00:00Z'), // excludes the 03-05 run
    });

    expect(r.totals.costMicros).toBe(3_000_000); // 03-05 run is outside the window
    expect(r.rows.length).toBe(2);
    expect(r.rows[0].label).toBe('2026-03-02'); // most recent day first
    expect(r.rows[0].costMicros).toBe(2_000_000);
    expect(r.rows[1].label).toBe('2026-03-01');
    expect(r.since).toBe('2026-03-01T00:00:00.000Z');
  });

  it('groups by run, keyed by run id, labeled by title or agent label', async () => {
    const a = await mkRun({ projectId: projectA, costMicros: 2_000_000 });
    const b = await mkRun({ projectId: projectA, costMicros: 1_000_000 });

    const r = await getSpendRollup({ groupBy: 'run', projectId: projectA });

    expect(r.rows.length).toBe(2);
    expect(r.rows[0].key).toBe(a.id); // higher spend first
    expect(r.rows[0].costMicros).toBe(2_000_000);
    expect(r.rows[0].label).toBe(tag); // no title → falls back to agent label
    expect(r.rows[1].key).toBe(b.id);
  });

  it('caps rows at the limit, flags truncation, but keeps totals over ALL matching runs', async () => {
    await mkRun({ projectId: projectA, agent: `${tag}-a`, costMicros: 3_000_000 });
    await mkRun({ projectId: projectA, agent: `${tag}-b`, costMicros: 2_000_000 });
    await mkRun({ projectId: projectA, agent: `${tag}-c`, costMicros: 1_000_000 });

    const r = await getSpendRollup({ groupBy: 'agent', projectId: projectA, limit: 2 });

    expect(r.rows.length).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.rows.map((x) => x.label)).toEqual([`${tag}-a`, `${tag}-b`]); // top-2 by spend
    expect(r.totals.costMicros).toBe(6_000_000); // totals are limit-independent
    expect(r.totals.runCount).toBe(3);
  });

  it('returns no rows and zeroed totals when nothing matches', async () => {
    await mkRun({ projectId: projectA, costMicros: 1_000_000 });

    const r = await getSpendRollup({ groupBy: 'project', agentLabel: `${tag}-nonexistent` });

    expect(r.rows).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(r.totals).toEqual({
      runCount: 0,
      costMicros: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

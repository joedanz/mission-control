// ABOUTME: Tests recordRunEnd's `authoritative` override. The daemon records claude's own total_cost_usd/usage
// ABOUTME: to correct the hooks' transcript estimate; since the authoritative cost can be LOWER than the
// ABOUTME: (cache-mispriced) estimate, it must SET exactly — the default GREATEST guard would keep the wrong
// ABOUTME: higher value. Real Neon DB.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, runs, events } from '../lib/db/schema';
import { createProject, recordRunStart, recordRunEnd } from '../lib/mutations';

describe('recordRunEnd authoritative override', () => {
  let projectId: string;
  let runIds: string[];

  beforeEach(async () => {
    runIds = [];
    const p = await createProject({
      name: `vitest-auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      category: 'internal',
      status: 'prelaunch',
    });
    projectId = p.id;
  });

  afterEach(async () => {
    await db.delete(events).where(eq(events.projectId, projectId));
    if (runIds.length) await db.delete(runs).where(inArray(runs.id, runIds));
    await db.delete(projects).where(eq(projects.id, projectId));
  });

  const readRun = async (id: string) => (await db.select().from(runs).where(eq(runs.id, id)))[0];

  it('SETs metrics exactly, overriding a higher GREATEST estimate posted first', async () => {
    const run = await recordRunStart({ agentLabel: 'vitest-auth', projectId });
    runIds.push(run.id);

    // The hook posts its (inflated) transcript estimate first.
    await recordRunEnd(run.id, 'completed', { costMicros: 336_000, tokensIn: 16, tokensOut: 466 });
    expect((await readRun(run.id)).costMicros).toBe(336_000);

    // The daemon then posts claude's authoritative — and LOWER — numbers with the override.
    await recordRunEnd(run.id, 'completed', { costMicros: 220_530, tokensIn: 21, tokensOut: 549 }, true);
    const r = await readRun(run.id);
    expect(r.costMicros).toBe(220_530); // SET, not greatest(336000, 220530)
    expect(r.tokensIn).toBe(21);
    expect(r.tokensOut).toBe(549);
  });

  it('without authoritative, GREATEST keeps the higher value (control)', async () => {
    const run = await recordRunStart({ agentLabel: 'vitest-auth', projectId });
    runIds.push(run.id);
    await recordRunEnd(run.id, 'completed', { costMicros: 336_000 });
    await recordRunEnd(run.id, 'completed', { costMicros: 220_530 }); // default GREATEST
    expect((await readRun(run.id)).costMicros).toBe(336_000);
  });
});

// ABOUTME: Slice-1 agent-profiles coverage — pure match/validation logic plus the DB-backed mutations,
// ABOUTME: the auto-routing resolver (rule precedence + default fallback), and the run→profile linkage.
// ABOUTME: Runs against the real Neon instance (DATABASE_URL); each test cleans up the rows it creates.

import { describe, it, expect, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { agentProfiles, projects, runs, events } from '../lib/db/schema';
import {
  createProfile,
  updateProfile,
  setDefaultProfile,
  deleteProfile,
  recordRunStart,
  recordProfileCheckIn,
} from '../lib/mutations';
import { getProfileBySlug, getProfiles, resolveProfile, getSpendRollup } from '../lib/queries';
import { profileMatchesContext, validateProfile, scanForLeakedSecrets, isValidCron } from '../lib/profiles';
import { ValidationError, ConflictError } from '../lib/validation';
import { SCHEDULE_MAX_FAILURES, SCHEDULE_MIN_INTERVAL_SEC } from '../lib/constants';

const created: string[] = []; // profile ids to clean up
const startedRuns: string[] = [];
const tag = () => `vt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function mkProfile(slug: string, extra: Record<string, unknown> = {}) {
  const p = await createProfile({ slug, name: slug, ...extra } as Parameters<typeof createProfile>[0]);
  created.push(p.id);
  return p;
}

afterEach(async () => {
  if (startedRuns.length) {
    await db.delete(events).where(inArray(events.runId, startedRuns));
    await db.delete(runs).where(inArray(runs.id, startedRuns));
    startedRuns.length = 0;
  }
  if (created.length) {
    await db.delete(agentProfiles).where(inArray(agentProfiles.id, created));
    created.length = 0;
  }
});

// ── Pure logic (no DB) ─────────────────────────────────────────────────────────

describe('profileMatchesContext (pure)', () => {
  it('matches when every present rule passes (ANDed)', () => {
    const rules = { projectSlugs: ['acme'], labelPattern: '^fix:' };
    expect(profileMatchesContext(rules, { projectSlug: 'acme', taskLabel: 'fix: bug' })).toBe(true);
    expect(profileMatchesContext(rules, { projectSlug: 'acme', taskLabel: 'feat: x' })).toBe(false);
    expect(profileMatchesContext(rules, { projectSlug: 'other', taskLabel: 'fix: bug' })).toBe(false);
  });

  it('empty / null rules never match (default-only profiles)', () => {
    expect(profileMatchesContext(null, { projectSlug: 'acme' })).toBe(false);
    expect(profileMatchesContext({}, { projectSlug: 'acme' })).toBe(false);
  });

  it('a rule whose dimension is absent from ctx fails closed', () => {
    expect(profileMatchesContext({ labelPattern: 'deploy' }, { projectSlug: 'acme' })).toBe(false);
    expect(profileMatchesContext({ labelPattern: 'deploy' }, { taskLabel: 'deploy the app' })).toBe(true);
  });

  it('labelPattern is a regex tested against the task label', () => {
    expect(profileMatchesContext({ labelPattern: '^fix:' }, { taskLabel: 'fix: crash' })).toBe(true);
    expect(profileMatchesContext({ labelPattern: '^fix:' }, { taskLabel: 'feat: thing' })).toBe(false);
  });
});

describe('validateProfile (pure)', () => {
  it("runtime 'exec' requires an exec template", () => {
    expect(() => validateProfile({ runtime: 'exec' })).toThrow(ValidationError);
    expect(() => validateProfile({ runtime: 'exec', execTemplate: 'run.sh ${PROMPT}' })).not.toThrow();
  });
  it('rejects unknown runtime / permissionMode', () => {
    expect(() => validateProfile({ runtime: 'magic' })).toThrow(ValidationError);
    expect(() => validateProfile({ runtime: 'claude-code', permissionMode: 'yolo' })).toThrow(ValidationError);
  });
  it('validates mcpServers shape', () => {
    expect(() => validateProfile({ runtime: 'claude-code', mcpServers: { x: { type: 'stdio' } } })).toThrow(ValidationError);
    expect(() => validateProfile({ runtime: 'claude-code', mcpServers: { x: { type: 'http', url: 'https://x' } } })).not.toThrow();
    expect(() => validateProfile({ runtime: 'claude-code', mcpServers: { x: { type: 'webhook' as never, url: 'https://x' } } })).toThrow(ValidationError);
  });
  it('rejects an un-compilable label regex', () => {
    expect(() => validateProfile({ runtime: 'claude-code', matchRules: { labelPattern: '([' } })).toThrow(ValidationError);
  });
  it('rejects a negative dailyBudgetMicros', () => {
    expect(() => validateProfile({ runtime: 'claude-code', dailyBudgetMicros: -1 })).toThrow(ValidationError);
    expect(() => validateProfile({ runtime: 'claude-code', dailyBudgetMicros: 5_000_000 })).not.toThrow();
  });
  it('rejects non-string-array jsonb fields (skills/allowedTools/disallowedTools)', () => {
    expect(() => validateProfile({ runtime: 'claude-code', skills: 'not-an-array' as never })).toThrow(ValidationError);
    expect(() => validateProfile({ runtime: 'claude-code', allowedTools: [1, 2] as never })).toThrow(ValidationError);
    expect(() => validateProfile({ runtime: 'claude-code', disallowedTools: [{}] as never })).toThrow(ValidationError);
    expect(() => validateProfile({ runtime: 'claude-code', skills: ['a', 'b'], allowedTools: ['Bash'] })).not.toThrow();
  });
});

describe('scanForLeakedSecrets (pure)', () => {
  it('flags raw secrets but not ${ENV} placeholders', () => {
    expect(scanForLeakedSecrets({ env: { TOKEN: '${GITHUB_TOKEN}' } })).toHaveLength(0);
    expect(scanForLeakedSecrets({ env: { TOKEN: 'ghp_0123456789abcdefghijABCDEF' } })).toHaveLength(1);
    const mcp = { gh: { type: 'http' as const, url: 'https://x', headers: { Authorization: 'Bearer sk-abcdef0123456789ABCDEF' } } };
    expect(scanForLeakedSecrets({ mcpServers: mcp })).toHaveLength(1);
  });
});

// ── DB-backed mutations + resolver ───────────────────────────────────────────────

describe('profile mutations', () => {
  it('creates with sensible defaults and round-trips by slug', async () => {
    const slug = tag();
    const p = await mkProfile(slug, { model: 'opus' });
    expect(p.runtime).toBe('claude-code');
    expect(p.skills).toEqual([]);
    expect(p.enabled).toBe(true);
    expect(p.isDefault).toBe(false);
    const fetched = await getProfileBySlug(slug);
    expect(fetched?.id).toBe(p.id);
    expect(fetched?.model).toBe('opus');
  });

  it('round-trips the cost-aware fields (fallbackModel + dailyBudgetMicros)', async () => {
    const p = await mkProfile(tag(), { model: 'opus', fallbackModel: 'claude-haiku-4-5', dailyBudgetMicros: 5_000_000 });
    const fetched = await getProfileBySlug(p.slug);
    expect(fetched?.fallbackModel).toBe('claude-haiku-4-5');
    expect(fetched?.dailyBudgetMicros).toBe(5_000_000);
  });

  it('update changes only provided keys and re-validates the effective profile', async () => {
    const p = await mkProfile(tag(), { model: 'opus' });
    const updated = await updateProfile(p.id, { model: 'claude-sonnet-4-6', priority: 5 });
    expect(updated?.model).toBe('claude-sonnet-4-6');
    expect(updated?.priority).toBe(5);
    expect(updated?.name).toBe(p.name); // untouched
    // switching runtime to exec without a template (none on the row) must fail the effective-profile check
    await expect(updateProfile(p.id, { runtime: 'exec' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('maps a duplicate slug to a clean ConflictError (not a leaked DB error)', async () => {
    const slug = tag();
    await mkProfile(slug);
    await expect(createProfile({ slug, name: 'dup' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('maps a second default to a ConflictError pointing at set-default', async () => {
    const a = await mkProfile(tag(), { isDefault: true });
    expect(a.isDefault).toBe(true);
    await expect(mkProfile(tag(), { isDefault: true })).rejects.toBeInstanceOf(ConflictError);
  });

  it('deleteProfile removes the row and returns it', async () => {
    const p = await mkProfile(tag());
    const removed = await deleteProfile(p.id);
    expect(removed?.id).toBe(p.id);
    created.pop(); // already gone
    expect(await getProfileBySlug(p.slug)).toBeNull();
  });
});

describe('setDefaultProfile', () => {
  it('keeps exactly one default and flips it', async () => {
    const a = await mkProfile(tag());
    const b = await mkProfile(tag());
    await setDefaultProfile(a.id);
    await setDefaultProfile(b.id);
    const all = (await getProfiles()).filter((p) => created.includes(p.id));
    expect(all.filter((p) => p.isDefault).map((p) => p.id)).toEqual([b.id]);
  });

  it('a non-existent target is a no-op that preserves the current default (no permanent zero-default)', async () => {
    const a = await mkProfile(tag());
    await setDefaultProfile(a.id);

    const missing = await setDefaultProfile('00000000-0000-0000-0000-000000000000');
    expect(missing).toBeNull();

    // The old clear-then-set order would have wiped a's default before the no-op set → zero defaults.
    const all = (await getProfiles()).filter((p) => created.includes(p.id));
    expect(all.filter((p) => p.isDefault).map((p) => p.id)).toEqual([a.id]);
  });
});

describe('resolveProfile (auto-routing)', () => {
  it('picks the highest-priority matching profile, else the default', async () => {
    const def = await mkProfile(tag());
    await setDefaultProfile(def.id);
    const slug = `acme-${tag()}`;
    const lo = await mkProfile(tag(), { matchRules: { projectSlugs: [slug] }, priority: 1 });
    const hi = await mkProfile(tag(), { matchRules: { projectSlugs: [slug] }, priority: 9 });

    const matched = await resolveProfile({ projectSlug: slug });
    expect(matched?.id).toBe(hi.id);
    expect(lo.id).not.toBe(hi.id);

    // a project with no matching rule falls back to the default
    const fallback = await resolveProfile({ projectSlug: `unmatched-${tag()}` });
    expect(fallback?.id).toBe(def.id);
  });

  it('disabled profiles never resolve', async () => {
    const slug = `dis-${tag()}`;
    const off = await mkProfile(tag(), { matchRules: { projectSlugs: [slug] }, priority: 5, enabled: false });
    const resolved = await resolveProfile({ projectSlug: slug });
    expect(resolved?.id).not.toBe(off.id);
  });
});

describe('run → profile linkage', () => {
  it('records agentProfileId and SET NULLs it when the profile is deleted', async () => {
    const p = await mkProfile(tag());
    const run = await recordRunStart({ agentLabel: 'vitest', source: 'cli', agentProfileId: p.id });
    startedRuns.push(run.id);
    expect(run.agentProfileId).toBe(p.id);

    await deleteProfile(p.id);
    created.pop();
    const after = await db.select().from(runs).where(eq(runs.id, run.id)).limit(1);
    expect(after[0].agentProfileId).toBeNull(); // FK SET NULL kept the run row
  });

  it('getSpendRollup scopes cost to one profile (the daemon budget lookup)', async () => {
    const p = await mkProfile(tag());
    const other = await mkProfile(tag());
    const r1 = await recordRunStart({ agentLabel: 'vitest', source: 'cli', agentProfileId: p.id });
    startedRuns.push(r1.id);
    await db.update(runs).set({ costMicros: 3_000_000 }).where(eq(runs.id, r1.id));
    const r2 = await recordRunStart({ agentLabel: 'vitest', source: 'cli', agentProfileId: other.id });
    startedRuns.push(r2.id);
    await db.update(runs).set({ costMicros: 9_000_000 }).where(eq(runs.id, r2.id));

    const rollup = await getSpendRollup({ profileId: p.id });
    expect(rollup.totals.costMicros).toBe(3_000_000); // only p's run, not other's
  });
});

// ── Scheduled check-ins (Slice 5) ────────────────────────────────────────────────

describe('validateProfile — scheduled check-ins (pure)', () => {
  it('always checks format: positive interval + parseable cron', () => {
    expect(() => validateProfile({ runtime: 'claude-code', scheduleIntervalSec: 0 })).toThrow(ValidationError);
    expect(() => validateProfile({ runtime: 'claude-code', scheduleIntervalSec: -5 })).toThrow(ValidationError);
    expect(() => validateProfile({ runtime: 'claude-code', scheduleCron: 'not a cron' })).toThrow(ValidationError);
    expect(() => validateProfile({ runtime: 'claude-code', scheduleCron: '0 9 * * 1-5' })).not.toThrow();
  });

  it('rejects an interval below the minimum floor (guards a runaway sub-minute typo)', () => {
    expect(() => validateProfile({ runtime: 'claude-code', scheduleIntervalSec: 30 })).toThrow(ValidationError);
    expect(() => validateProfile({ runtime: 'claude-code', scheduleIntervalSec: SCHEDULE_MIN_INTERVAL_SEC })).not.toThrow();
  });

  it('validates scheduleTimezone (IANA zone) whenever it is set', () => {
    expect(() => validateProfile({ runtime: 'claude-code', scheduleTimezone: 'Not/AZone' })).toThrow(ValidationError);
    expect(() => validateProfile({ runtime: 'claude-code', scheduleTimezone: 'America/New_York' })).not.toThrow();
    expect(() => validateProfile({ runtime: 'claude-code', scheduleTimezone: 'UTC' })).not.toThrow();
    expect(() => validateProfile({ runtime: 'claude-code', scheduleTimezone: null })).not.toThrow();
  });

  it('an enabled schedule requires a bound project', () => {
    expect(() => validateProfile({ runtime: 'claude-code', scheduleEnabled: true, scheduleIntervalSec: 900 })).toThrow(ValidationError);
    expect(() =>
      validateProfile({ runtime: 'claude-code', scheduleEnabled: true, scheduleProjectId: 'p1', scheduleIntervalSec: 900 }),
    ).not.toThrow();
  });

  it('an enabled schedule requires exactly one of interval / cron', () => {
    const base = { runtime: 'claude-code', scheduleEnabled: true, scheduleProjectId: 'p1' } as const;
    expect(() => validateProfile({ ...base })).toThrow(ValidationError); // neither
    expect(() => validateProfile({ ...base, scheduleIntervalSec: 900, scheduleCron: '0 9 * * *' })).toThrow(ValidationError); // both
    expect(() => validateProfile({ ...base, scheduleCron: '0 9 * * *' })).not.toThrow(); // cron only
  });

  it('a disabled schedule may be half-configured (turn it on later in one call)', () => {
    expect(() => validateProfile({ runtime: 'claude-code', scheduleEnabled: false, scheduleIntervalSec: 900 })).not.toThrow();
  });

  it('isValidCron guards real expressions', () => {
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
    expect(isValidCron('*/15 * * * *')).toBe(true);
    expect(isValidCron('not a cron')).toBe(false);
  });
});

describe('recordProfileCheckIn', () => {
  const projectIds: string[] = [];
  afterEach(async () => {
    if (projectIds.length) {
      await db.delete(projects).where(inArray(projects.id, projectIds));
      projectIds.length = 0;
    }
  });
  async function mkProject() {
    const slug = tag();
    const row = (
      await db.insert(projects).values({ name: slug, slug, category: 'internal', status: 'active', accent: 'orange' }).returning()
    )[0];
    projectIds.push(row.id);
    return row;
  }

  it('advances lastCheckInAt, tracks failures, and auto-pauses at the cap; ok resets', async () => {
    const proj = await mkProject();
    const p = await mkProfile(tag(), {
      scheduleEnabled: true,
      scheduleProjectId: proj.id,
      scheduleIntervalSec: SCHEDULE_MIN_INTERVAL_SEC, // at the floor — a valid short interval for the test
      checkInPrompt: 'do the thing',
    });
    expect(p.lastCheckInAt).toBeNull();

    // spawn-time call (no status): advance the clock, don't touch failures
    const t1 = await recordProfileCheckIn(p.slug);
    expect(t1?.lastCheckInAt).toBeInstanceOf(Date);
    expect(t1?.consecutiveFailures).toBe(0);

    const f1 = await recordProfileCheckIn(p.slug, 'fail');
    expect(f1?.consecutiveFailures).toBe(1);
    expect(f1?.scheduleEnabled).toBe(true);

    await recordProfileCheckIn(p.slug, 'fail');
    const f3 = await recordProfileCheckIn(p.slug, 'fail');
    expect(f3?.consecutiveFailures).toBe(SCHEDULE_MAX_FAILURES);
    expect(f3?.scheduleEnabled).toBe(false); // auto-paused after 3 strikes

    const ok = await recordProfileCheckIn(p.slug, 'ok');
    expect(ok?.consecutiveFailures).toBe(0); // a success clears the counter
  });

  it('returns null for an unknown slug', async () => {
    expect(await recordProfileCheckIn(`nope-${tag()}`)).toBeNull();
  });

  it('counts every concurrent fail report (atomic increment — no lost updates)', async () => {
    const proj = await mkProject();
    const p = await mkProfile(tag(), {
      scheduleEnabled: true,
      scheduleProjectId: proj.id,
      scheduleIntervalSec: SCHEDULE_MIN_INTERVAL_SEC,
      checkInPrompt: 'x',
    });

    const N = 5;
    await Promise.all(Array.from({ length: N }, () => recordProfileCheckIn(p.slug, 'fail')));

    // A JS read-modify-write would lose increments under concurrency; the in-DB `+1` cannot.
    const after = (await getProfileBySlug(p.slug))!;
    expect(after.consecutiveFailures).toBe(N);
    expect(after.scheduleEnabled).toBe(false); // crossed the cap atomically too
  });
});

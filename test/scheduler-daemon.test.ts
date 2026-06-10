// ABOUTME: Integration test for the scheduler daemon's --once tick, with a STUB executor (MC_DAEMON_EXEC=
// ABOUTME: 'exit 0') so the full list → isDue → run start → checked-in → spawn → finalize path runs without a
// ABOUTME: real `claude -p`. Proves a due profile spawns one cron-attributed run, the clock advances, and a
// ABOUTME: second immediate tick skips (not due). Real Neon DB; mc uses the DATABASE_URL fallback opt-in.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { db } from '../lib/db/index';
import { projects, runs, events, agentProfiles, tasks } from '../lib/db/schema';
import { createProject, createProfile, addTask } from '../lib/mutations';
import { getProfileBySlug } from '../lib/queries';

const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
// Isolate the test scheduler from the always-on production scheduler (M22): its own lock dir, so the two
// never contend on the shared $TMPDIR lockfile (which used to make `npm test` fail whenever the launchd
// scheduler service was running). `onlyProfile` scopes the tick to THIS test's fixture profile (M21) so a
// --once tick can't fire a real due profile and corrupt its check-in slot / queued task in the shared dev DB.
const lockDir = mkdtempSync(join(tmpdir(), 'mc-sched-test-'));
const runOnce = (onlyProfile: string) =>
  execFileSync(tsxBin, ['daemon/scheduler.ts', '--once'], {
    env: {
      ...process.env,
      MC_DAEMON_EXEC: 'exit 0', // stub: a clean child with no hooks → daemon owns the run.end
      MC_ALLOW_DATABASE_URL_FALLBACK: '1', // let the daemon's `mc` use DATABASE_URL (no mc_agent file in test)
      INGEST_TOKEN: '', // no telemetry posts from the test
      MC_LOCK_DIR: lockDir, // M22: don't contend with the live scheduler's lock
      MC_SCHEDULER_ONLY_PROFILE: onlyProfile, // M21: fire ONLY the fixture profile
    },
    encoding: 'utf8',
    timeout: 55000,
    stdio: 'pipe',
  });

describe('scheduler daemon — --once tick (stub executor)', () => {
  let projectId: string;
  const profileIds: string[] = [];

  beforeEach(async () => {
    const p = await createProject({
      name: `vitest-sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      category: 'internal',
      status: 'prelaunch',
      repoPath: '/tmp', // the stub executor's cwd must exist; contents are irrelevant
    });
    projectId = p.id;
  });

  afterEach(async () => {
    await db.delete(events).where(eq(events.projectId, projectId));
    await db.delete(runs).where(eq(runs.projectId, projectId));
    while (profileIds.length) await db.delete(agentProfiles).where(eq(agentProfiles.id, profileIds.pop()!));
    await db.delete(projects).where(eq(projects.id, projectId)); // cascades tasks
  });

  it(
    'fires a due profile once (cron-attributed run), advances the clock, and skips when not due',
    async () => {
      const slug = `vt-sched-${Date.now()}`;
      const profile = await createProfile({
        slug,
        name: slug,
        scheduleEnabled: true,
        scheduleProjectId: projectId,
        scheduleIntervalSec: 3600, // long interval → due only on the first tick (lastCheckInAt is null)
        checkInPrompt: 'Look for triage work.',
      });
      profileIds.push(profile.id);
      expect(profile.lastCheckInAt).toBeNull();

      // First tick: profile has never checked in → due → one run spawned.
      runOnce(slug);

      const after1 = await getProfileBySlug(slug);
      expect(after1?.lastCheckInAt).not.toBeNull(); // clock advanced
      expect(after1?.scheduleEnabled).toBe(true); // a clean exit → not auto-paused
      expect(after1?.consecutiveFailures).toBe(0); // exit 0 → completed → ok reset

      const runs1 = await db.select().from(runs).where(eq(runs.projectId, projectId));
      expect(runs1.length).toBe(1);
      expect(runs1[0].source).toBe('cron');
      expect(runs1[0].agentProfileId).toBe(profile.id);

      // Second immediate tick: now − lastCheckInAt ≪ 3600s → NOT due → no new run.
      runOnce(slug);
      const runs2 = await db.select().from(runs).where(eq(runs.projectId, projectId));
      expect(runs2.length).toBe(1);
    },
    110000,
  );

  it(
    'pre-claims a queued task to the check-in run; a clean completion auto-marks it done',
    async () => {
      const slug = `vt-claim-${Date.now()}`;
      const profile = await createProfile({
        slug,
        name: slug,
        scheduleEnabled: true,
        scheduleProjectId: projectId,
        scheduleIntervalSec: 3600,
        checkInPrompt: 'Do the queued work.',
      });
      profileIds.push(profile.id);
      const task = await addTask(projectId, 'pre-claim me');
      expect(task.status).toBe('todo');

      runOnce(slug); // due → run start → checked-in → claim task → spawn stub (exit 0) → clean completion

      // terminalizeClaimsForRun closes the loop: a completed run auto-marks its claimed custom tasks done
      // and clears the claim. Without the scheduler's pre-claim the task would still be 'todo' (the bug).
      const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
      expect(after.status).toBe('done');
      expect(after.claimedByRunId).toBeNull();
    },
    110000,
  );
});

// ABOUTME: Integration test for the auto-claim daemon's orchestration (Design A), with a STUB executor
// ABOUTME: (MC_DAEMON_EXEC='exit 0') so the full poll → mc run start → mc task claim → spawn → finalize loop
// ABOUTME: runs deterministically without a real `claude -p`. Proves a queued task goes todo → claimed →
// ABOUTME: done with a run attributed to the daemon. Real Neon DB; mc uses the DATABASE_URL fallback opt-in.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { db } from '../lib/db/index';
import { projects, runs, events, agentProfiles } from '../lib/db/schema';
import { createProject, addTask, createProfile } from '../lib/mutations';
import { getTaskById } from '../lib/queries';

describe('auto-claim daemon — --once orchestration (stub executor)', () => {
  let projectId: string;
  let slug: string;
  const profileIds: string[] = [];

  beforeEach(async () => {
    const p = await createProject({
      name: `vitest-daemon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      category: 'internal',
      status: 'prelaunch',
      repoPath: '/tmp', // the stub executor's cwd must exist; contents are irrelevant
    });
    projectId = p.id;
    slug = p.slug;
  });

  afterEach(async () => {
    await db.delete(events).where(eq(events.projectId, projectId));
    await db.delete(runs).where(eq(runs.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId)); // cascades tasks
    while (profileIds.length) {
      await db.delete(agentProfiles).where(eq(agentProfiles.id, profileIds.pop()!));
    }
  });

  it(
    'claims the queued task, runs the (stub) executor, and marks it done with a daemon-attributed run',
    async () => {
      const task = await addTask(projectId, 'stub-executed daemon task');

      const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
      execFileSync(tsxBin, ['daemon/auto-claim.ts', '--project', slug, '--once'], {
        env: {
          ...process.env,
          MC_DAEMON_EXEC: 'exit 0', // stub: a clean child with no hooks → daemon owns the run.end
          MC_ALLOW_DATABASE_URL_FALLBACK: '1', // let the daemon's `mc` use DATABASE_URL (no mc_agent file in test)
          INGEST_TOKEN: '', // belt-and-suspenders: no telemetry posts from the test
        },
        encoding: 'utf8',
        timeout: 55000,
        stdio: 'pipe',
      });

      // terminalizeClaimsForRun('completed') on the daemon's run.end marks the claimed task done.
      const t = await getTaskById(task.id);
      expect(t?.status).toBe('done');

      // The run exists, attributed to the daemon agent label, completed.
      const projRuns = await db.select().from(runs).where(eq(runs.projectId, projectId));
      expect(projRuns.length).toBe(1);
      expect(projRuns[0].agentLabel).toBe('auto-claim-daemon');
      expect(projRuns[0].status).toBe('completed');
    },
    60000,
  );

  it(
    'resolves a matching profile and links the run to it (run.agentProfileId)',
    async () => {
      // A profile whose rule matches THIS project — the resolver should pick it for the daemon's task.
      const prof = await createProfile({
        slug: `vt-daemon-prof-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: 'daemon test profile',
        matchRules: { projectSlugs: [slug] },
        priority: 5,
      });
      profileIds.push(prof.id);
      await addTask(projectId, 'profile-linked daemon task');

      const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
      execFileSync(tsxBin, ['daemon/auto-claim.ts', '--project', slug, '--once'], {
        env: {
          ...process.env,
          MC_DAEMON_EXEC: 'exit 0', // stub render; we're asserting the resolve→link orchestration, not the spawn
          MC_ALLOW_DATABASE_URL_FALLBACK: '1',
          INGEST_TOKEN: '',
        },
        encoding: 'utf8',
        timeout: 55000,
        stdio: 'pipe',
      });

      const projRuns = await db.select().from(runs).where(eq(runs.projectId, projectId));
      expect(projRuns.length).toBe(1);
      expect(projRuns[0].agentProfileId).toBe(prof.id); // mc profile resolve → mc run start --profile linked it
    },
    60000,
  );
});

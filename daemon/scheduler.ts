// ABOUTME: Scheduler daemon (Slice 5) — the GLOBAL, always-on sibling of the auto-claim daemon. Each tick it
// ABOUTME: asks `mc profile list --schedulable`, finds profiles whose interval/cron is due (isDue), and for each
// ABOUTME: spawns ONE check-in run bound to the profile's project repo with its standing-mission prompt. It
// ABOUTME: PRE-CLAIMS the next queued task to that run (like auto-claim), so a clean run-end auto-completes the
// ABOUTME: task (terminalizeClaimsForRun) without the agent needing to call mc; the prompt then invites the agent
// ABOUTME: to keep draining the queue (claim+complete up to --max-tasks total in the one session). NON-BLOCKING:
// ABOUTME: profiles are independent, so a long mission on one never blocks another — in-flight runs are monitored
// ABOUTME: async and a per-profile guard skips re-firing one that is still running. Reuses daemon/runner.ts.
//
// Run:   tsx daemon/scheduler.ts [--poll 60] [--once] [--permission-mode acceptEdits] [--timeout 900] [--grace 15] [--max-tasks 5]
// Stop:  SIGINT/SIGTERM (stops spawning, lets in-flight check-ins finish, then exits).
// Single instance globally (tmpdir lockfile). Liveness/crash recovery of spawned runs is the existing reaper.

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProfile } from '../lib/db/schema';
import { chooseModel, MissingSkillError, type ModelChoice } from './render-profile';
import { CHECK_IN_MAX_TASKS } from '../lib/constants';
import { mc, sleep, profileSpendTodayMicros, spawnExecutor, monitorAndFinalize, recordDowngrade, acquireLock, fetchComposioMcpServers, type Spawned } from './runner';
import { isDue, buildCheckInPrompt } from './schedule';

const AGENT_LABEL = process.env.MC_SCHEDULER_AGENT || 'mc-scheduler';

// Grant the mc CLI to every check-in spawn. The ONE pre-claimed task completes without it (the scheduler
// pre-claims and run-end auto-completes — see claimNextTask), but mc is load-bearing for DRAINING beyond it:
// when --max-tasks > 1 the prompt has the agent claim+complete more queued tasks via `mc task next/claim/
// set-status` (see buildCheckInPrompt). Also used for observability (in_progress, `mc event add` notes).
// Granted regardless of the profile's own allowedTools so those calls aren't denied under permission-mode
// acceptEdits/default in headless mode. (No-op under bypassPermissions, which already allows everything.)
const CHECK_IN_TOOLS = ['Bash(mc:*)'];

type Args = { once: boolean; pollSec: number; permissionMode: string; timeoutSec: number; graceSec: number; maxTasks: number };

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    once: argv.includes('--once'),
    pollSec: Number(get('--poll')) || 60, // matches the reaper's launchd cadence
    // A check-in's job is to ACT (claim + work tasks), so the base default is acceptEdits, not plan — plan
    // makes the agent only propose, which (even with the Bash(mc:*) grant) would never claim anything. A
    // profile's own permissionMode still overrides; pass --permission-mode to change this scheduler-wide.
    permissionMode: get('--permission-mode') || 'acceptEdits',
    timeoutSec: Number(get('--timeout')) || 900,
    graceSec: Number(get('--grace')) || 15,
    // How many queued tasks one check-in may drain in a single run (board order). Drives the prompt's drain
    // invitation, not a pre-claim count — see buildCheckInPrompt. --max-tasks > env > the CHECK_IN_MAX_TASKS default.
    maxTasks: Number(get('--max-tasks')) || Number(process.env.MC_CHECKIN_MAX_TASKS) || CHECK_IN_MAX_TASKS,
  };
}

const log = (msg: string) => console.log(`[scheduler ${new Date().toISOString()}] ${msg}`);

let shuttingDown = false;

type Project = { id: string; slug: string; name: string; repoPath: string | null };

/** Check-ins spawned by THIS scheduler that are still running, keyed by profile slug → its monitor promise.
 *  Doubles as the skip-if-live guard (don't start a second check-in for a profile whose previous one hasn't
 *  finished) AND the set --once/shutdown await before exiting. */
const inFlight = new Map<string, Promise<void>>();

type ClaimedTask = { id: string; label: string; notes: string | null };

/** Claim the next claimable task in the project to `runId` (board order, via the mc CLI so DB scope stays at
 *  that boundary). Returns the claimed task, or null when the queue is empty / a transient mc failure / a lost
 *  claim race — every "null" path is a fine mission-only check-in, so this never throws and never blocks. */
async function claimNextTask(slug: string, runId: string): Promise<ClaimedTask | null> {
  const next = await mc(['task', 'next', '--project', slug]);
  if (!next.ok) {
    log(`task next failed for ${slug} (${next.error?.code ?? next.code}) — mission-only check-in`);
    return null;
  }
  const task = next.data as ClaimedTask | null;
  if (!task) return null; // queue empty
  const claim = await mc(['task', 'claim', task.id, '--run', runId]);
  if (!claim.ok) {
    log(`claim of "${task.label}" lost/failed (${claim.error?.code ?? claim.code}) — mission-only check-in`);
    return null;
  }
  return task;
}

/** Run one profile's check-in to completion: spawn → monitor → finalize → record ok/fail. Self-contained so
 *  the tick can fire-and-forget it (the caller adds/removes the in-flight guard). Never throws. */
async function runCheckIn(profile: AgentProfile, project: Project, a: Args): Promise<void> {
  const repoPath = project.repoPath as string; // checked by the caller before firing
  const runId = randomUUID();

  // Today's per-profile spend for the cost-aware model pick (same budget downgrade as auto-claim).
  const spentToday = await profileSpendTodayMicros(profile, log);
  const choice: ModelChoice = chooseModel(profile, spentToday);

  const startArgs = ['run', 'start', '--id', runId, '--agent', AGENT_LABEL, '--source', 'cron', '--profile', profile.slug, '--project', project.slug, '--work-dir', repoPath, '--title', `check-in: ${profile.slug}`];
  if (choice.model) startArgs.push('--model', choice.model);
  // M2: check the run-start envelope. The old code fire-and-forgot it, then advanced the clock + claimed +
  // spawned anyway — so a failed start left a paid `claude` run pointing at a nonexistent run row (invisible,
  // un-killable) while the schedule still recorded `ok`. On failure, record a fail (counts toward the 3-strike
  // auto-pause) and return without claiming or spawning.
  const started = await mc(startArgs);
  if (!started.ok) {
    log(`run start for check-in "${profile.slug}" failed (${started.error?.code ?? started.code}) — recording fail, not spawning`);
    await mc(['profile', 'checked-in', profile.slug, '--status', 'fail']);
    return;
  }

  // Advance the clock NOW (at spawn), so the next tick sees it as not-due and we don't double-fire while it runs.
  await mc(['profile', 'checked-in', profile.slug]);

  // Pre-claim the next queued task to THIS run (like auto-claim) so tracking doesn't hinge on the agent calling
  // mc: a clean run.end auto-marks the run's claimed task done (terminalizeClaimsForRun), a failed/abandoned one
  // releases it back to the queue. Best-effort — no task / lost race → a mission-only check-in.
  const claimedTask = await claimNextTask(project.slug, runId);
  const prompt = buildCheckInPrompt(profile, project, claimedTask, a.maxTasks);

  if (choice.downgraded) await recordDowngrade(choice, profile, spentToday, runId, project.slug, log);
  // Auto-feed the project's ACTIVE Composio connections as MCP servers (runCheckIn always has a profile).
  const extraMcpServers = await fetchComposioMcpServers(project.slug, runId, log);

  const how = process.env.MC_DAEMON_EXEC ? 'executor (MC_DAEMON_EXEC)' : `profile ${profile.slug} (${profile.runtime}${choice.model ? `, model ${choice.model}` : ''})`;
  const work = claimedTask ? `task "${claimedTask.label}"` : 'mission only';
  log(`check-in for "${profile.slug}" → project ${project.slug} under run ${runId.slice(0, 8)} (${work}) — spawning ${how}`);

  let spawned: Spawned;
  try {
    spawned = spawnExecutor({ prompt, runId, repoPath, profile, effectiveModel: choice.model, basePermissionMode: a.permissionMode, extraAllowedTools: CHECK_IN_TOOLS, extraMcpServers });
  } catch (e) {
    const msg = (e as Error).message;
    const skillMiss = e instanceof MissingSkillError;
    log(`spawn ${skillMiss ? 'skill resolution' : 'render'} failed for "${profile.slug}": ${msg} — failing run`);
    await mc(['event', 'add', msg, '--type', skillMiss ? 'skill.unresolved' : 'note', '--level', 'error', '--run', runId, '--project', project.slug]);
    await mc(['run', 'end', runId, 'failed']);
    await mc(['profile', 'checked-in', profile.slug, '--status', 'fail']); // count it against the auto-pause budget
    return;
  }

  const { status } = await monitorAndFinalize(spawned, runId, { timeoutSec: a.timeoutSec, graceSec: a.graceSec }, log);
  const ok = status === 'completed';
  await mc(['profile', 'checked-in', profile.slug, '--status', ok ? 'ok' : 'fail']);
  log(`run ${runId.slice(0, 8)} → ${status} (check-in ${ok ? 'ok' : 'fail'} for "${profile.slug}")`);
}

/** One scheduling pass: find due profiles, then (only if any are due) load the project map and fire them
 *  (non-blocking). Computing "due" first means a tick with profiles configured but none yet due skips the
 *  project-list round-trip entirely. */
async function tick(a: Args): Promise<void> {
  const profsR = await mc(['profile', 'list', '--schedulable']);
  if (!profsR.ok) {
    log(`profile list failed (${profsR.error?.code ?? profsR.code}) — skipping this tick`);
    return;
  }
  const now = new Date();
  const due = ((profsR.data as { items: AgentProfile[] }).items ?? []).filter((profile) => {
    if (inFlight.has(profile.slug)) return false; // its previous check-in is still running → skip this tick
    // mc serializes timestamps to ISO strings; rehydrate lastCheckInAt for the date math.
    const lastCheckInAt = profile.lastCheckInAt ? new Date(profile.lastCheckInAt as unknown as string) : null;
    return isDue({ scheduleIntervalSec: profile.scheduleIntervalSec, scheduleCron: profile.scheduleCron, scheduleTimezone: profile.scheduleTimezone, lastCheckInAt }, now);
  });
  if (!due.length) return;

  const projsR = await mc(['project', 'list', '--archived', 'all']);
  if (!projsR.ok) {
    log(`project list failed (${projsR.error?.code ?? projsR.code}) — skipping this tick`);
    return;
  }
  const byId = new Map<string, Project>();
  for (const p of (projsR.data as { items: Project[] }).items ?? []) byId.set(p.id, p);

  for (const profile of due) {
    if (shuttingDown) break;
    const project = profile.scheduleProjectId ? byId.get(profile.scheduleProjectId) : undefined;
    if (!project) {
      log(`profile "${profile.slug}" is due but its scheduled project is missing — skipping`);
      continue;
    }
    if (!project.repoPath) {
      log(`profile "${profile.slug}" is due but project "${project.slug}" has no repoPath — skipping`);
      continue;
    }

    const promise = runCheckIn(profile, project, a)
      .catch((e) => log(`check-in for "${profile.slug}" crashed: ${e instanceof Error ? e.message : e}`))
      .finally(() => inFlight.delete(profile.slug));
    inFlight.set(profile.slug, promise);
  }
}

async function drainInFlight(): Promise<void> {
  if (!inFlight.size) return;
  log(`waiting for ${inFlight.size} in-flight check-in(s) to finish…`);
  await Promise.allSettled([...inFlight.values()]);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (shuttingDown) process.exit(130);
      shuttingDown = true;
      log(`${sig} received — no new check-ins; finishing in-flight ones, then stopping (repeat to force-quit)`);
    });
  }

  const releaseLock = acquireLock(join(tmpdir(), 'mc-scheduler.lock'), 'the scheduler'); // one instance globally
  process.on('exit', releaseLock);

  log(`started — mode=${a.once ? 'once' : `poll ${a.pollSec}s`} permission=${a.permissionMode}`);
  while (!shuttingDown) {
    await tick(a);
    if (a.once) break;
    await sleep(a.pollSec * 1000);
  }
  await drainInFlight();
  log('stopped');
}

main().catch((e) => {
  console.error('scheduler daemon crashed:', e);
  process.exit(1);
});

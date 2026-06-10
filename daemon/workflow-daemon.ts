// ABOUTME: Workflow daemon (Slice 4) — the GLOBAL, always-on executor of QUEUED workflow runs. Each tick it
// ABOUTME: lists queued workflow_runs (enqueued by the canvas Run button or `mc workflow run --async`), claims
// ABOUTME: each race-safe (queued→running, so two daemons / a double-tick can't double-execute), and walks it
// ABOUTME: to completion via the shared walkWorkflowRun. NON-BLOCKING: runs execute concurrently, so a long
// ABOUTME: one never blocks another; an in-flight guard keeps the --once/shutdown drain honest. A crashed walk
// ABOUTME: is reconciled by the reaper (reapStaleWorkflowRuns), exactly like the auto-claim/scheduler daemons.
//
// Run:   tsx daemon/workflow-daemon.ts [--poll 5] [--once] [--timeout 900] [--grace 15]
// Stop:  SIGINT/SIGTERM (stops claiming, lets in-flight walks finish, then exits).
// Single instance globally (tmpdir lockfile). Crash recovery of a dead walk is the existing reaper.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sleep, acquireLock, type Log } from './runner';
import { listQueuedWorkflowRuns, claimWorkflowRun, listWorkflows, latestCronRunAt } from '../lib/workflow-store';
import { walkWorkflowRun } from './workflow-runner';
import { enqueueWorkflowRun } from '../lib/workflow-enqueue';
import { triggerSchedule } from '../lib/workflows';
import { ConflictError } from '../lib/validation';
import { isDue } from './schedule';

type Args = { once: boolean; pollSec: number; timeoutSec: number; graceSec: number };

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    once: argv.includes('--once'),
    // Short by default: a queued run is usually a user clicking "Run" and waiting on the canvas, so we want
    // it picked up promptly. Each poll is one cheap indexed SELECT.
    pollSec: Number(get('--poll')) || 5,
    timeoutSec: Number(get('--timeout')) || 900,
    graceSec: Number(get('--grace')) || 15,
  };
}

const log: Log = (msg) => console.log(`[workflow-daemon ${new Date().toISOString()}] ${msg}`);

let shuttingDown = false;

/** Runs THIS daemon has claimed and is still walking, keyed by run id → its walk promise. PRIMARY purpose: the
 *  set that --once / shutdown drains before exiting. Also a skip-guard if a walk outlives the tick that started
 *  it — though a claimed run flips to 'running', so listQueuedWorkflowRuns already stops returning it next tick. */
const inFlight = new Map<string, Promise<void>>();

/** Cron trigger (slice 7): enqueue a 'cron' run for each ACTIVE workflow whose schedule is due, reusing the
 *  scheduler's isDue. The due-math anchor is the last cron run's startedAt, or — before the first fire — the
 *  workflow's updatedAt, so a freshly-activated cron waits for its next real instant instead of firing instantly.
 *  enqueueWorkflowRun's single-flight guard suppresses a fire while a run is already queued/running (ConflictError
 *  → skip), so a slow workflow never piles up; the just-enqueued run is then claimed + walked by THIS same tick's
 *  drain loop. Best-effort throughout: a list/enqueue failure logs and the tick proceeds to drain queued runs. */
async function scanCronWorkflows(): Promise<void> {
  let active;
  try {
    active = await listWorkflows({ status: 'active' });
  } catch (e) {
    log(`cron scan: list active workflows failed: ${e instanceof Error ? e.message : e} — skipping scan`);
    return;
  }
  const now = new Date();
  for (const wf of active) {
    if (shuttingDown) break;
    let schedule;
    try {
      schedule = triggerSchedule(wf.graph); // null = a manual / un-scheduled trigger
    } catch {
      continue; // a malformed graph that slipped past create-time validation — never crash the scan
    }
    if (!schedule) continue;

    // The ONE unguarded await in this otherwise best-effort scan: a transient Neon failure here would reject
    // scanCronWorkflows → tick → main → process.exit(1), killing the whole daemon (every in-flight walk loses
    // its walker). Guard it like every sibling call — log + skip this workflow.
    let anchor;
    try {
      anchor = (await latestCronRunAt(wf.id)) ?? wf.updatedAt;
    } catch (e) {
      log(`cron scan: anchor read for ${wf.slug} failed: ${e instanceof Error ? e.message : e} — skipping this workflow`);
      continue;
    }
    const fields = { scheduleCron: schedule.cron ?? null, scheduleIntervalSec: schedule.intervalSec ?? null, scheduleTimezone: schedule.timezone ?? null, lastCheckInAt: anchor };
    if (!isDue(fields, now)) continue;

    try {
      const run = await enqueueWorkflowRun(wf.slug, { trigger: 'cron' });
      log(`cron: workflow ${wf.slug} due → enqueued run ${run.id.slice(0, 8)}`);
    } catch (e) {
      // ConflictError = a run is already queued/running (single-flight) → not an error, just skip this fire.
      if (!(e instanceof ConflictError)) log(`cron enqueue of ${wf.slug} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/** One pass: enqueue due cron workflows (slice 7), then list queued runs, claim each race-safe, fire-and-forget
 *  its walk. Per-run try/catch so a single bad run (DB blip on claim, etc.) never aborts the whole tick. */
async function tick(a: Args): Promise<void> {
  await scanCronWorkflows(); // enqueue this tick's due cron runs; the drain loop below claims + walks them
  let queued;
  try {
    queued = await listQueuedWorkflowRuns();
  } catch (e) {
    log(`list queued failed: ${e instanceof Error ? e.message : e} — skipping this tick`);
    return;
  }

  for (const run of queued) {
    if (shuttingDown) break;
    if (inFlight.has(run.id)) continue; // already executing in this process

    let claimed;
    try {
      claimed = await claimWorkflowRun(run.id); // race-safe; null = another worker won / cancelled before pickup
    } catch (e) {
      log(`claim of run ${run.id.slice(0, 8)} failed: ${e instanceof Error ? e.message : e} — will retry next tick`);
      continue;
    }
    if (!claimed) continue;

    log(`claimed workflow run ${run.id.slice(0, 8)} (workflow ${run.workflowId.slice(0, 8)}) — executing`);
    const promise = walkWorkflowRun(claimed, { timeoutSec: a.timeoutSec, graceSec: a.graceSec, log })
      .then((r) => log(`workflow run ${run.id.slice(0, 8)} → ${r.status}`))
      // walkWorkflowRun marks the run failed on a clean throw; a hard crash is the reaper's job. Just log here.
      .catch((e) => log(`workflow run ${run.id.slice(0, 8)} crashed: ${e instanceof Error ? e.message : e}`))
      .finally(() => inFlight.delete(run.id));
    inFlight.set(run.id, promise);
  }
}

async function drainInFlight(): Promise<void> {
  if (!inFlight.size) return;
  log(`waiting for ${inFlight.size} in-flight workflow run(s) to finish…`);
  await Promise.allSettled([...inFlight.values()]);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (shuttingDown) process.exit(130);
      shuttingDown = true;
      log(`${sig} received — no new claims; finishing in-flight runs, then stopping (repeat to force-quit)`);
    });
  }

  const releaseLock = acquireLock(join(tmpdir(), 'mc-workflow-daemon.lock'), 'the workflow daemon'); // one instance globally
  process.on('exit', releaseLock);

  log(`started — mode=${a.once ? 'once' : `poll ${a.pollSec}s`} timeout=${a.timeoutSec}s`);
  while (!shuttingDown) {
    await tick(a);
    if (a.once) break;
    await sleep(a.pollSec * 1000);
  }
  await drainInFlight();
  log('stopped');
}

main().catch((e) => {
  console.error('workflow daemon crashed:', e);
  process.exit(1);
});

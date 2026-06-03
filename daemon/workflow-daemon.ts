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
import { listQueuedWorkflowRuns, claimWorkflowRun } from '../lib/workflow-store';
import { walkWorkflowRun } from './workflow-runner';

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

/** One pass: list queued runs, claim each race-safe, fire-and-forget its walk. Per-run try/catch so a single
 *  bad run (DB blip on claim, etc.) never aborts the whole tick. */
async function tick(a: Args): Promise<void> {
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

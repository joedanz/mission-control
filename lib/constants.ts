// ABOUTME: Shared Mission Control timing constants — the single source for run liveness/staleness.
// ABOUTME: Read by `cc run list --active`, the activity feed, and the reaper so they never drift.

/** A `running` run with no heartbeat within this window is "stale" — the reaper flips it to
 *  'abandoned' and `live` is computed false. Agent hooks (PostToolUse) heartbeat well inside it.
 *  Single source read by the reaper, getRecentRuns, and `cc run list --active`. */
export const RUN_STALE_THRESHOLD_SEC = 120;

/** How long a task claim is held before it auto-expires and the task becomes claimable again.
 *  Run-backed claims are normally freed sooner: the reaper releases them the moment their run is
 *  abandoned (no heartbeat > RUN_STALE_THRESHOLD_SEC). So this TTL is the BACKSTOP for that path and
 *  the ONLY release for a manual (null-run) claim — deliberately generous (must exceed normal task
 *  duration so a live holder's claim isn't stolen mid-work; heartbeats do NOT refresh it). Operators
 *  can override per-claim via `cc task claim --ttl`. */
export const CLAIM_TTL_SEC = RUN_STALE_THRESHOLD_SEC * 15; // 30 min

/** The axes `cc spend` / getSpendRollup can roll cost up over. Single source so the CLI flag, the query
 *  signature, and the /spend page guard can't drift. Lives here (not lib/queries) so the CLI can import
 *  the runtime array at top level without eagerly loading lib/db. */
export const SPEND_GROUP_BYS = ['project', 'agent', 'day', 'run'] as const;
export type SpendGroupBy = (typeof SPEND_GROUP_BYS)[number];

/** A profile's scheduled check-in auto-pauses (schedule_enabled → false) after this many consecutive
 *  failed check-in runs, so a persistently-broken schedule stops burning spawns. Mirrors Cabinet's
 *  3-strike auto-pause. A successful check-in resets the counter. Read by recordProfileCheckIn. */
export const SCHEDULE_MAX_FAILURES = 3;

/** Floor for a profile's interval-mode check-in. Each check-in spawns a real (paid) agent run, so a
 *  sub-minute interval (e.g. a `--schedule-interval 1` typo) would fire one every scheduler tick — a cost
 *  runaway. 60s matches the scheduler's default poll cadence: the smallest interval that can meaningfully
 *  differ from "every tick". Enforced by validateProfile (write time) and the CLI's early coercion. */
export const SCHEDULE_MIN_INTERVAL_SEC = 60;

/** How many queued tasks one check-in run may drain in a single wake-up (board order). The scheduler
 *  pre-claims the FIRST task; the check-in prompt then invites the agent to claim+complete more (up to this
 *  many total) via the documented self-dispatch loop — see buildCheckInPrompt. A cap (not unbounded) bounds
 *  one run's blast radius so it can't monopolise the queue or run away on cost. Override per-scheduler with
 *  `--max-tasks` / the MC_CHECKIN_MAX_TASKS env; `1` = the single pre-claimed task only. */
export const CHECK_IN_MAX_TASKS = 5;

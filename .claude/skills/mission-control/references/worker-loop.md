# Worker loop — self-serving a Mission Control task

This is the loop a worker agent runs to pick up, do, and complete a task while keeping Mission
Control's telemetry honest. Read [cli-contract.md](cli-contract.md) first for the envelope and
`error.code` rules.

## The loop

```
mc run start --agent <label> [--project <slug>]   # capture the printed runId → MC_RUN_ID
mc task next [--project <slug>]                    # the next claimable task (or null)
mc task claim <task-id>                            # race-safe; CONFLICT = lost the race
mc task set-status <task-id> in_progress           # optional — reflects on the board
… do the work …
mc event add "<what happened>" --type note --run <run-id> --task <task-id>   # 'note' = free-form; no 'progress' type
mc task set-status <task-id> done
mc run end <run-id> completed --cost-micros <n> --tokens-in <n> --tokens-out <n>
```

**Start the run first.** Without an open run there is nothing to attribute the claim, events, and
status changes to, and the cost rollup breaks. `mc run start` prints the `runId` — capture it into
`MC_RUN_ID` (see Attribution). **Daemon-spawned agents already have `MC_RUN_ID` set and should skip
`run start`** — they're running inside a run the daemon opened.

**Event `--type` must be a real `eventType`.** For a free-form progress/work note the type is
**`note`** — there is no `progress`/`update`/`working` type, and guessing one returns a `VALIDATION`
error. Lifecycle types are specific (`task.status_changed`, `run.ended`, `tool_call`, …); run
`mc enums --json` for the full set rather than inventing a value.

## Attribution — group your writes under your run

Every mutating `mc` command records an actor. Set two environment variables so all your writes
group under your run:

- `MC_AGENT` — your label (e.g. `claude-code`). Defaults to `mc` if unset.
- `MC_RUN_ID` — the run your actions belong to. `mc run start` prints the `runId`; export it.

```
export MC_AGENT=claude-code
export MC_RUN_ID="$(mc run start --agent claude-code --project habitcraft)"   # human mode prints the bare id
```

With these set, `mc task claim`, `mc event add`, `mc task set-status`, and `mc run end` all attach to
the same run automatically — you don't need to repeat `--run` (though passing it explicitly is fine).
Daemon-spawned agents inherit `MC_RUN_ID`; the SessionStart hook also writes a cwd-keyed run id.

## Claim invariants (the traps this skill exists to prevent)

- **Claiming is race-safe.** Two agents can call `mc task next` and see the same task; only one wins
  `mc task claim`. The loser gets `CONFLICT` (exit 1) — **re-fetch `mc task next` and move on**; this
  is expected contention, not an error to escalate.
- **Claim ≠ status change.** `claim` does not move the task to `in_progress`. If you want the board
  to show it as active, call `mc task set-status <id> in_progress` separately.
- **One in-flight task per run.** While you hold a live claim on an unfinished task, claiming a
  second one returns `CONFLICT`. A run is a single sequential session — finish (or end the run)
  before taking another task.
- **`set-status done` does NOT release the claim.** The claim pointer lingers until the TTL expires
  (default **30 minutes**), the reaper releases it, or you `mc run end`. So end your run when done;
  don't expect a finished task to immediately free a claim slot.
- **Extend long work** with `mc task claim <id> --ttl <seconds>` if it may exceed 30 minutes.

## Run metrics

`mc run end` accepts `--tokens-in/--tokens-out/--cache-read/--cache-write/--cost-micros`. These are
**absolute cumulative** totals with a monotonic guard — a smaller/out-of-order value never regresses
the stored total. Pass `--authoritative` to set the exact final total (overrides the guard).
`cost-micros` is integer micro-dollars; `mc spend` sums it. Terminal statuses: `completed`, `failed`,
`abandoned` (anything but `running`).

## Recovering from a lost claim

```
mc task claim <id>      # → {"ok":false,"error":{"code":"CONFLICT",...}}
# CONFLICT here = someone else claimed it, or you already hold a live claim. Don't fail the run:
mc task next            # get the next claimable task and continue the loop
```

## A worked end-to-end sequence

For a concrete, runnable agent loop (claim → work → integration call → events → run end), see the
repo runbook `docs/runbooks/composio-linear-smoke.md`. It exercises the same primitives against a
real project and is a good template to mirror.

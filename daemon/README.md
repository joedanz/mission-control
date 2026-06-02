# Auto-claim daemon

An unattended worker that pulls tasks from the Mission Control queue and runs each one as a fresh
headless `claude -p` session in the project's repo. It is the **execution** half of self-dispatch: the
claim machinery (PR #7/#9) decided *what* to pick up; this decides *how to run it*.

**Design A** (per-task spawned children). One run id per task flows through everything:

```
mc task next --project <slug>          # FIFO peek (getNextClaimableTask)
mc run start --id <uuid> ...           # pre-register the run (agent=auto-claim-daemon)
mc task claim <task> --run <uuid>      # claim BEFORE spawn — race-safe, no claim-after-spawn window
claude -p "<task>" --permission-mode plan   # child runs in repoPath with MC_RUN_ID=<uuid>
        ↑ the child's SessionStart hook ADOPTS MC_RUN_ID, so telemetry + heartbeats + the
          R9 kill-switch all bind to the SAME run the daemon registered and claimed
```

Everything downstream is reused, not rebuilt: the child's global hooks post `run.start`/heartbeats/`run.end`,
the kill-switch enforces cancellation, `terminalizeClaimsForRun` marks the task done on a clean exit (or
releases it on failure/cancel), and the reaper recovers a crashed child. The daemon adds only the
poll/claim/spawn/monitor/finalize loop.

## Run it

```bash
# Prereqs: `mc` configured (AGENT_DATABASE_URL or ~/.config/mc/env), the global Claude Code hooks
# wired in ~/.claude/settings.json, and the project has a repoPath:
mc project set-repo <slug> /path/to/repo

# One task then exit (the recommended first proof):
npm run daemon -- --project <slug> --once

# Continuous: poll every 10s, one task in flight at a time:
npm run daemon -- --project <slug>
```

### Flags

| flag | default | meaning |
|---|---|---|
| `--project <slug>` | *(required)* | only claim tasks from this project |
| `--once` | off | process one task (or exit if the queue is empty) then stop |
| `--poll <sec>` | `10` | idle poll interval when the queue is empty |
| `--permission-mode <m>` | `plan` | passed to `claude -p`. **Start with `plan`** (a research-only dry run, no edits). |
| `--timeout <sec>` | `900` | wall-clock cap per task; the child's process group is terminated past it |
| `--grace <sec>` | `15` | after a cancel/timeout, how long to let the kill-switch hook halt the child before SIGTERM→SIGKILL |
| `--max-tasks <n>` | ∞ | stop after N tasks (useful for bounded runs) |

## Safety

- **Start in plan mode.** `--permission-mode plan` lets the child research and produce a plan but make no
  edits — the smallest blast radius for proving the loop. Graduate to a narrow `--allowedTools` + a git
  worktree only once the loop and the kill-switch are trusted. **Never run unattended with `bypassPermissions`.**
- **Untrusted task text.** Tasks created by `mc task import-issues` carry GitHub issue titles authored by
  anyone with access to the repo. The daemon delimits the task text in the child prompt and frames it as
  data, but that is **not** a substitute for the permission policy: keep issue-sourced tasks at `plan` mode
  (or human-gate them) before ever running them with `--allowedTools`/edits.
- **Kill switch (live, R9).** `mc run cancel <runId>` (the daemon prints the runId it claimed under) →
  the child's next heartbeat caches the cancel flag → its PreToolUse hook halts the **next tool call**.
  PreToolUse only fires *between* tools, so the hook cannot interrupt a child mid-way through one long `Bash`
  (a build, `npm install`, a hung `curl`); there the only stop is the daemon's OS-signal backstop — it polls
  `mc run get <runId>` (~2s) and, `--grace` seconds after a cancel, SIGTERMs then SIGKILLs the child's whole
  process group (a `--timeout` SIGTERMs immediately). Worst-case hard-stop latency for a wedged child is
  roughly `--grace` (cancel) or `--timeout + --grace` (timeout); the reaper is the final backstop if the
  daemon itself dies.
- **Cancel never marks work done.** `recordRunEnd` coerces `completed → abandoned` when the run was
  cancelled, so a halted task is **released** back to the queue, not silently marked complete.
- **One instance per repo, enforced.** A per-repoPath lockfile (`$TMPDIR/mc-daemon-<hash>.lock`) refuses to
  start a second daemon on the same repo — two children sharing a cwd would clobber each other's cwd-keyed
  run id + kill-switch flag. Parallelism = run daemons in **distinct** project repos (each its own run + lock,
  race-safe via `claimTask`).
- **Crash recovery is free.** If the daemon or a child dies, the run stops heartbeating; the reaper flips it
  `abandoned` after 120s and releases its claim back to `todo`.

## Executor environment

The child `claude -p` must run under a Node version its build supports. The daemon strips `NODE_OPTIONS`
before spawning (so the parent's tsx loader can't leak into claude and corrupt its module init), but it
does **not** pin a Node version. If a bare `claude -p '…' --permission-mode plan` works from your normal
shell, the daemon will run it; if your shell's `claude` resolves to a different install or Node than what
the daemon inherits, point the daemon at the right one with the executor override:

```bash
MC_DAEMON_EXEC='/abs/path/to/claude -p "$MC_TASK_LABEL" --permission-mode plan --output-format json' \
  npm run daemon -- --project <slug> --once
```

(Running the daemon *nested inside another Claude Code session* can hand the child an incompatible ambient
Node — run it from a plain terminal instead.) Whatever the executor exit status, the loop is safe: a
non-zero exit ends the run `failed` and releases the task back to `todo` for a later retry.

## Testing

The orchestration is covered by `test/auto-claim-daemon.test.ts` (a `--once` run with a stub executor —
`MC_DAEMON_EXEC='exit 0'` — so the full loop is exercised deterministically without a real model). The
cancel-guard is covered by `test/run-end-cancel-guard.test.ts`, and the `MC_RUN_ID` adoption by
`test/session-start-runid.test.ts`.

Override the executor for your own dry runs:

```bash
MC_DAEMON_EXEC='echo "would run: $MC_TASK_LABEL"; exit 0' npm run daemon -- --project <slug> --once
```

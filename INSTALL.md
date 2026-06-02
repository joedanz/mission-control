# Installing Mission Control's local services

Mission Control runs a few **local** background services on the machine that owns the agents — there is no
hosted cron (see [`LAUNCH.md`](LAUNCH.md) §4):

| Service | What it does | Cadence | Plist |
|---|---|---|---|
| **reaper** (`npm run reap`) | flips `running` runs with no heartbeat (120s) to `abandoned` and frees their task claims | one-shot every 60s | `ops/local.mc.reap.plist` |
| **scheduler** (`npm run scheduler`) | wakes agent profiles whose scheduled **check-in** is due and spawns one run per profile in its bound project's repo | long-running poll loop (60s) | `ops/local.mc.scheduler.plist` |
| **auto-claim** (`npm run daemon -- --project <slug>`) | pulls tasks from **one** project's queue and runs each as a `claude -p` child in its repo | long-running, **per-project** | `ops/local.mc.daemon.plist` (template) |

> Both the **scheduler** and **auto-claim** spawn `claude` and so need the `MC_CLAUDE_BIN` pin (Prerequisite
> 4). auto-claim is per-project (one daemon per repo) — its install is in [`ops/README.md`](ops/README.md);
> this guide walks through the scheduler in detail and they install the same way.

> "check-in" = a **scheduled wake-up** (configure with `mc profile … --schedule-enabled`). It is distinct
> from the liveness *heartbeat* (`runs.last_heartbeat_at`) the reaper watches.

This guide covers installing the **scheduler** as a launchd service. The reaper installs identically — see
[`ops/README.md`](ops/README.md) for both plists, the crontab alternative, and reinstall/uninstall commands.

---

## Prerequisites

1. **The repo + deps.** `npm install` in this repo (adds `croner`, used by the scheduler's due-math).
2. **`mc` CLI credentials.** Both daemons do every DB read/write by shelling out to `mc`, which needs a
   scoped `AGENT_DATABASE_URL` — resolved from (in order) the `AGENT_DATABASE_URL` env var,
   `$MC_ENV_FILE`, or `~/.config/mc/env` (must be `chmod 600`). Confirm it works:
   ```bash
   mc profile list --schedulable --json    # must return {"ok":true,...}
   ```
   (No file? See `cli/README.md` → Credentials. The daemon refuses to run without a scoped credential.)
3. **`node`/`npm` on a known PATH.** launchd does **not** inherit your shell PATH — the plist hard-codes
   `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`. Adjust it if your node lives elsewhere (`which node`).
4. **A working `claude` (the executor) — pin it.** A check-in spawns `claude` to run the agent. Because the
   scheduler is launched via `npm run`, npm prepends the `node_modules/.bin` walk to PATH, which can shadow
   your real install with a stale npm-global `@anthropic-ai/claude-code` that **crashes on newer Node**
   (a `safe-buffer`/`google-auth` prototype error at startup). Pin the absolute path instead of trusting PATH:
   ```bash
   command -v claude            # in a CLEAN shell — e.g. /Users/you/.local/bin/claude
   claude --version             # confirm it actually runs
   ```
   Set that path as **`MC_CLAUDE_BIN`** (the plist already carries a slot for it — see §3). The daemon spawns
   `MC_CLAUDE_BIN` if set, else bare `claude`. To prove it before installing:
   ```bash
   MC_CLAUDE_BIN=/abs/path/to/claude npm run scheduler -- --once
   ```

---

## 1. Configure at least one check-in

A profile only fires when its schedule is enabled and bound to a project with a `repoPath`:

```bash
# the project must have a repo on disk (mc project set-repo <slug> <path> if not)
mc profile add --slug morning-triage --name "Morning Triage" \
  --schedule-enabled --schedule-project my-app \
  --schedule-cron "0 9 * * 1-5" \           # weekdays 9am local time …
  --check-in-prompt "Triage new issues and pick up any queued work."
# …or a simple interval instead of cron:
#   --schedule-interval 1800                # every 30 minutes
```

Verify it's schedulable: `mc profile list --schedulable`.

> **Check-ins can self-serve out of the box.** The scheduler auto-grants the `mc` CLI tool to every check-in
> spawn (`Bash(mc:*)`) and its base permission mode is `acceptEdits`, so the standing-mission prompt's
> `mc task claim` calls run (and file edits are auto-approved) without any per-profile setup. Tune per profile
> if needed:
> ```bash
> mc profile update morning-triage --permission-mode bypassPermissions  # fully autonomous (any tool) …
> #   …or --permission-mode plan to make this profile only PROPOSE (it won't claim/close tasks).
> ```
> (To change the scheduler-wide default, pass `--permission-mode <mode>` to `npm run scheduler`.)

---

## 2. Prove the loop manually FIRST

Do **not** install the service until one tick is proven against your real profile. `--once` runs a single
tick, waits for any check-in it spawns to finish, then exits:

```bash
npm run scheduler -- --once
```

Watch the log lines: `started — mode=once …` → `check-in for "morning-triage" → project my-app under run …`
→ `run … → completed`. Then confirm the run landed:

```bash
mc run list --active            # the check-in run while it's live
mc profile get morning-triage   # last_check_in_at advanced; consecutive_failures 0
```

(If a profile is configured but not yet due, `--once` simply exits with nothing to do — that's correct.)

---

## 3. Install the launchd service (macOS)

The scheduler is **long-running**, so its plist is `RunAtLoad` + `KeepAlive` (relaunch on crash/logout) —
not a `StartInterval` one-shot like the reaper. It logs to `/tmp/mc-scheduler.log`.

> **Edit `ops/local.mc.scheduler.plist` first** if this isn't the default machine: the `cd` path
> (`/path/to/mission`), `PATH`, and `MC_CLAUDE_BIN` (the executor path from Prerequisite 4) are
> all baked in and machine-specific.

```bash
# Copy (don't symlink — launchd wants it under LaunchAgents) and load:
cp ops/local.mc.scheduler.plist ~/Library/LaunchAgents/local.mc.scheduler.plist
launchctl load ~/Library/LaunchAgents/local.mc.scheduler.plist
```

---

## 4. Verify it's running

```bash
launchctl list local.mc.scheduler     # a live PID in column 1 = the service is up (exit code in column 2)
tail -f /tmp/mc-scheduler.log        # "started — mode=poll 60s …" then per-check-in lines every cadence
```

Only one scheduler runs at a time — a `$TMPDIR/mc-scheduler.lock` lockfile makes a second instance refuse
to start (so a manual `npm run scheduler` won't collide with the service).

---

## 5. Manage / uninstall

```bash
# Stop the service:
launchctl unload ~/Library/LaunchAgents/local.mc.scheduler.plist

# Reinstall after editing the plist:
launchctl unload ~/Library/LaunchAgents/local.mc.scheduler.plist
cp ops/local.mc.scheduler.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/local.mc.scheduler.plist

# Pause a single profile's check-ins without touching the service:
mc profile update morning-triage --schedule-disabled
```

A profile also **auto-pauses** itself (`schedule_enabled → false`, with a warn event) after 3 consecutive
failed check-ins, so a persistently-broken schedule stops burning runs. Re-enable with
`mc profile update <slug> --schedule-enabled` once fixed.

---

## Tuning flags (`npm run scheduler -- <flags>`)

| Flag | Default | Meaning |
|---|---|---|
| `--poll <sec>` | `60` | tick interval (how often it checks for due profiles) |
| `--once` | — | run a single tick, await in-flight check-ins, exit (proof / cron-style use) |
| `--permission-mode <m>` | `acceptEdits` | base Claude Code permission posture; a profile's own `permissionMode` overrides it |
| `--timeout <sec>` | `900` | wall-clock cap per check-in run before SIGTERM→SIGKILL |
| `--grace <sec>` | `15` | cooperative grace after cancel before the OS-signal backstop |
| `--max-tasks <n>` | `5` | how many queued tasks one check-in may drain in a single run — the scheduler pre-claims the first; the prompt invites the agent to claim+complete more (up to this many) before stopping. `1` = the pre-claimed task only |

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `MC_CLAUDE_BIN` | `claude` (off PATH) | absolute path to the `claude` executor a check-in spawns — pin it (Prerequisite 4) so `npm run` can't shadow it with a broken install |
| `MC_CHECKIN_MAX_TASKS` | `5` | default for `--max-tasks` (the flag overrides it) — handy for the launchd service, which runs with no flags |
| `AGENT_DATABASE_URL` / `MC_ENV_FILE` | — | scoped DB credential `mc` resolves (Prerequisite 2) |

If the machine sleeps, due check-ins simply fire on the next tick after wake — no harm, just a delay.

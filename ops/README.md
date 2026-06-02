# ops — local scheduling artifacts

The reaper (`npm run reap`) flips `running` runs with no heartbeat in the stale window (120s) to
`abandoned` and frees crashed agents' task claims. It runs **locally on a schedule** — there is no
Vercel cron (see `LAUNCH.md` §4). This directory version-controls that schedule so a fresh clone or
machine rebuild can reinstate it instead of silently running with no reaper.

## `local.mc.reap.plist` — macOS launchd (recommended)

Runs `npm run reap` every 60s, logging to `/tmp/mc-reap.log`. **Machine-specific:** the `cd` path
(`/path/to/mission`) and the `PATH` (Homebrew node/npm) are baked in — edit them for
another machine.

```bash
# Install (copy, don't symlink — launchd wants it under LaunchAgents):
cp ops/local.mc.reap.plist ~/Library/LaunchAgents/local.mc.reap.plist
launchctl load ~/Library/LaunchAgents/local.mc.reap.plist

# Verify it's loaded and firing:
launchctl list local.mc.reap          # PID/last-exit (0 = healthy)
tail -f /tmp/mc-reap.log            # a line every ~60s: "no stale runs" or "abandoned N …"

# Reinstall after editing the plist:
launchctl unload ~/Library/LaunchAgents/local.mc.reap.plist
cp ops/local.mc.reap.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/local.mc.reap.plist
```

## crontab alternative (any Unix)

```cron
# PATH is prepended because cron runs with a minimal PATH (/usr/bin:/bin) that has no Homebrew node/npm.
* * * * * cd /path/to/mission && PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin npm run reap >> /tmp/mc-reap.log 2>&1
```

If the machine sleeps, stale runs are simply reaped on the next tick — no harm, just a delay. An HTTP
alternative (`POST/GET /api/cron/reap`, bearer `CRON_SECRET`) exists if you'd rather drive it from an
external scheduler; not needed when this job is loaded.

## `local.mc.scheduler.plist` — agent profile check-ins (macOS launchd)

> For a step-by-step walkthrough (prerequisites, configuring a check-in, the manual `--once` proof, install,
> verify, manage), see [`../INSTALL.md`](../INSTALL.md). This section is the plist reference.

The scheduler (`npm run scheduler`) wakes agent profiles that have **scheduled check-ins** enabled
(`mc profile … --schedule-enabled`) on their interval/cron, spawning one check-in run per due profile
in the bound project's repo. Unlike the reaper, it is a **long-running service** with its own poll loop,
so this plist is `RunAtLoad` + `KeepAlive` (relaunch on crash/logout), not a `StartInterval` one-shot.
Logs to `/tmp/mc-scheduler.log`. **Machine-specific:** the `cd` path (`/path/to/mission`)
and the `PATH` (Homebrew node/npm) are baked in — edit them for another machine.

> Prove it works manually FIRST: `npm run scheduler -- --once` (one tick, then exits) against a real
> profile with a short interval, and confirm a check-in run shows up in `mc run list --active`. Only
> then install the LaunchAgent.

```bash
# Install (copy, don't symlink — launchd wants it under LaunchAgents):
cp ops/local.mc.scheduler.plist ~/Library/LaunchAgents/local.mc.scheduler.plist
launchctl load ~/Library/LaunchAgents/local.mc.scheduler.plist

# Verify it's loaded and running:
launchctl list local.mc.scheduler     # a live PID = the service is up
tail -f /tmp/mc-scheduler.log       # "started — mode=poll 60s …" then per-check-in lines

# Reinstall after editing the plist:
launchctl unload ~/Library/LaunchAgents/local.mc.scheduler.plist
cp ops/local.mc.scheduler.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/local.mc.scheduler.plist
```

Only one scheduler runs at a time (a `$TMPDIR/mc-scheduler.lock` lockfile makes a second instance refuse
to start). Stop it with `launchctl unload …`.

## `local.mc.daemon.plist` — auto-claim daemon (macOS launchd, **per-project**)

The auto-claim daemon (`npm run daemon -- --project <slug>`) pulls tasks from **one** project's queue and
runs each as a headless `claude -p` child in its repo. Like the scheduler it is a long-running service
(`RunAtLoad` + `KeepAlive`), but it is **scoped to a single project** (concurrency 1; a per-repoPath lockfile
refuses a second daemon on the same repo). So this plist is a **template** — deploy one copy per project.

> Same `MC_CLAUDE_BIN` requirement as the scheduler: `npm run` can shadow the real `claude` with a broken
> npm-global install, so the plist pins the absolute executor path. See [`../INSTALL.md`](../INSTALL.md)
> Prerequisite 4. **Prove it manually first:** `MC_CLAUDE_BIN=/abs/claude npm run daemon -- --project <slug>
> --once --permission-mode plan` (processes one task, plan-only/no edits, then exits).

```bash
# Per project: substitute the slug into BOTH the Label and the --project arg, and give it a unique log path.
sed 's/__PROJECT__/my-app/g' ops/local.mc.daemon.plist > ~/Library/LaunchAgents/local.mc.daemon.my-app.plist
launchctl load ~/Library/LaunchAgents/local.mc.daemon.my-app.plist

launchctl list local.mc.daemon.my-app   # a live PID = up
tail -f /tmp/mc-daemon-my-app.log      # per-task lines

# Stop / reinstall (repeat per project):
launchctl unload ~/Library/LaunchAgents/local.mc.daemon.my-app.plist
```

Start in `--permission-mode plan` (no edits — smallest blast radius) and treat imported issue titles as
untrusted. To let a daemon actually edit, add `--permission-mode acceptEdits` to the plist's `npm run daemon`
line. Parallelism = one daemon per **distinct** repo.

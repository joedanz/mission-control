# Launch checklist

Everything that must be true before this is live in production. Live domain: **your-app.example.com**.
Detail/rationale lives in [`README.md`](README.md) (roles, security model) and [`hooks/README.md`](hooks/README.md)
(agent telemetry); this file is the actionable list. Check items off as they're confirmed.

> Convention: ✅ done · ⬜ to do/verify. Update as you go.

## 1. Environment variables (Vercel → Production)

| Var | Value | Notes |
|-----|-------|-------|
| ✅ `DATABASE_URL` | the **app** role string (`app_user`) | **Deployed 2026-05-29** — read/write incl. auth tables, no DDL/owner; never the owner string |
| ✅ `BETTER_AUTH_SECRET` | strong unique random | **Set in prod** (verified `vercel env ls` 2026-05-29) |
| ✅ `BETTER_AUTH_URL` | `https://your-app.example.com` | **Set in prod**; sign-in works, so it matches the live origin |
| ✅ `NEXT_PUBLIC_BETTER_AUTH_URL` | `https://your-app.example.com` | **Set in prod**; same origin |
| ✅ `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from Google Cloud | **Set in prod** |
| ✅ `ALLOWED_EMAIL` | `you@example.com` | **Set in prod**; fail-closed: empty ⇒ nobody can sign in |
| ✅ `INGEST_TOKEN` | strong random secret | **Set in prod** (2026-05-29); `/api/ingest` verified 200-with-token / 401-without |
| 🚫 `CRON_SECRET` | strong random secret | **Intentionally NOT set in prod** — only the HTTP reaper (`/api/cron/reap`) needs it; we use the launchd `npm run reap` path (§4), which doesn't. |
| 🚫 `AGENT_DATABASE_URL` | — | **NEVER set in Vercel.** Scoped agent role for the CLI only (see §5). |

Mirror the new secrets locally in `.env.local` if testing ingest/reaper there (they're documented in `.env.example`).

## 2. Database (production Neon)

- ✅ **Migrations applied.** `0001_*` (runs/events + `tasks.version`) and `0002_*` (task-claim columns) are
  applied to the production DB. Local `.env.local` `DATABASE_URL` should point at an **isolated Neon `dev`
  branch** (see `.env.example`), NOT prod — so local migrations/seeds never touch live data. Migrating prod
  is a deliberate owner action: run `npm run db:migrate` with the prod owner string swapped in. (Vercel never
  runs migrations.)
- ✅ **Scoped roles created (2026-05-29)** via SQL as owner (no Neon CLI). Three roles: `neondb_owner` (local
  migrations/seed), `app_user` (Vercel prod — read/write incl. auth, no DDL/owner), `mc_agent` (CLI — scoped):
  ```sql
  GRANT SELECT, INSERT, UPDATE, DELETE ON projects, tasks TO mc_agent;
  GRANT SELECT, INSERT, UPDATE ON runs, events TO mc_agent;   -- no DELETE: append-only / update-only; no auth tables
  ```
  `events.seq` is `GENERATED AS IDENTITY`, so table INSERT suffices — no sequence grant needed.
- ✅ Verified: `mc_agent` reads/writes `projects`/`tasks`/`runs`/`events` and is **denied** on `users`; `app_user`
  reads/writes auth tables but is denied `CREATE TABLE` / `CREATE ROLE`.

## 3. Auth / Google OAuth

- ✅ Authorized redirect URI in Google Cloud includes `https://your-app.example.com/api/auth/callback/google` (sign-in succeeds, so it's registered).
- ✅ `BETTER_AUTH_URL` / `NEXT_PUBLIC_BETTER_AUTH_URL` / the OAuth redirect URI **all** match the live domain.
- ✅ Sign-in confirmed for `you@example.com` (2026-05-29 — Mission + Projects render authenticated). Other accounts are rejected fail-closed by `ALLOWED_EMAIL` (config-enforced, not separately exercised).

## 4. Mission Control — reaper (run locally, not a hosted cron)

The reaper flips `running` runs with no heartbeat in the stale window (120s) to `abandoned` so dead agents
don't show as live forever. We run it **locally on a schedule** — no Vercel Cron / Pro plan needed.

- ✅ Confirms it runs: `npm run reap` → prints `no stale runs` (uses `DATABASE_URL` from `.env.local`).
- ✅ Scheduled every minute via launchd `local.mc.reap` (loaded, last exit 0, firing every ~60s — `/tmp/mc-reap.log` verified 2026-05-29). Two options:

  **macOS — launchd (survives reboots, recommended):** create `~/Library/LaunchAgents/local.mc.reap.plist`:
  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0"><dict>
    <key>Label</key><string>local.mc.reap</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/sh</string><string>-lc</string>
      <string>cd /path/to/mission && npm run reap</string>
    </array>
    <key>StartInterval</key><integer>60</integer>
    <key>StandardOutPath</key><string>/tmp/mc-reap.log</string>
    <key>StandardErrorPath</key><string>/tmp/mc-reap.log</string>
  </dict></plist>
  ```
  Then: `launchctl load ~/Library/LaunchAgents/local.mc.reap.plist` (tail `/tmp/mc-reap.log` to verify).

  **Or crontab (any Unix):**
  ```cron
  * * * * * cd /path/to/mission && /usr/bin/env npm run reap >> /tmp/mc-reap.log 2>&1
  ```
- Note: if the machine sleeps, stale runs are simply reaped on the next run — no harm, just a delay.
- **HTTP alternative (optional):** the app also exposes `POST/GET /api/cron/reap` (bearer `CRON_SECRET`) if you'd
  rather have an external scheduler trigger it over HTTP. Not needed when using `npm run reap`.

## 4b. Mission Control — scheduler (agent profile check-ins, run locally)

The scheduler (`npm run scheduler`) wakes agent profiles whose scheduled **check-in** is due and spawns one
run per profile in its bound project's repo. Like the reaper it runs locally — but it's a **long-running
service** (`RunAtLoad` + `KeepAlive`), not a one-shot. Full walkthrough in [`INSTALL.md`](INSTALL.md).

- Prove a tick manually first: `npm run scheduler -- --once` → a due profile spawns a check-in run.
- Install: `cp ops/local.mc.scheduler.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/local.mc.scheduler.plist` (logs `/tmp/mc-scheduler.log`).
- Optional until check-ins are actually used — install when you want profile schedules to fire unattended.

## 5. Agents / `mc` CLI (not on Vercel)

- ✅ Production `mc_agent` Neon role created + granted (see README "three database roles" + §2 above).
- ✅ The `mc` CLI uses `AGENT_DATABASE_URL` (mc_agent) from `~/.config/mc/env` (chmod 600) + `.env.local` — **never** committed, never in Vercel.
- ✅ Claude Code telemetry hooks wired in `~/.claude/settings.json` (`INGEST_TOKEN`, `MC_INGEST_URL=https://your-app.example.com/api/ingest`,
  `MC_AGENT=claude-code`, plus `SessionStart`/`PostToolUse`/`Stop`/`SubagentStop`). **Verified live 2026-05-29** — the Mission feed
  shows real `claude-code` `run.started`/`run.ended` events (incl. session: compact/clear) captured from local sessions.

## 6. Pre-launch smoke test (against prod)

- ✅ Sign in → Overview / Projects render (verified 2026-05-29 under the `app_user` prod role).
- ✅ Open the **Mission** tab → activity feed + runs strip load with real captured telemetry.
- ✅ `curl -X POST https://your-app.example.com/api/ingest -H "Authorization: Bearer $INGEST_TOKEN" ... '{"type":"run.start",...}'` → `{ok:true}`; bad token → 401 (verified 2026-05-29).
- ✅ The smoke run appeared in the Mission tab; `run.end` left it out of the "live" set (FLEET `0 LIVE`).
- ✅ `npm run build` is green on Vercel deploy — the deployment is live and serving authenticated pages.
- ✅ GitHub Actions CI (`.github/workflows/ci.yml`) runs `tsc --noEmit` + scoped `eslint` on every push/PR. Note:
  the DB-backed `npm test` suite is NOT in CI (it hits a real Neon branch and mutates shared rows); run it locally.

## Known deferrals (NOT launch blockers)

- ✅ **Dollar cost from transcript is SHIPPED** (PR #13/#17 — `hooks/pricing.mjs` per-model rate table prices each
  transcript message; cost rolls up via `mc spend` + the Spend tab). Note: `runs.model` is still null, so cost is
  attributed per-message, not per-run — a per-*model* breakdown would need per-message model attribution first.
- ✅ Logged-in visual QA of the Mission tab done 2026-05-29 (Mission + Projects render authenticated under `app_user`).
- ✅ Phase 2 **task claiming is SHIPPED** (PR #7 — `mc task next` / `mc task claim`, race-safe single-statement claim).
- ✅ **GitHub-issue auto-sourcing is SHIPPED** (PR #10 — `mc task import-issues <slug>` fills the queue from a
  project's GitHub issues, idempotent by issue number).
- Still future work: per-agent ingest tokens (today `agentLabel` is self-asserted, fine for one trusted operator) — see `tasks/todo.md`.

# Mission Control

A web-accessible, fully-editable project dashboard backed by Neon (Postgres). Both the web
UI and a CLI write to the same database, so AI agents have a centralized, integrated place to
track project state.

**Stack:** Next.js 16 (App Router) · Neon serverless + Drizzle ORM · BetterAuth (Google OAuth,
locked to `you@example.com`) · Vercel.

## Local setup

1. `cp .env.example .env.local` and fill it in (see below).
2. `npm install`
3. `npm run db:migrate` — apply migrations to Neon (run as the **owner** role).
4. `npm run dev` — open http://localhost:3000 and sign in with Google as `you@example.com`.

Useful: `npm run db:studio` (Drizzle Studio), `npm run db:generate` (regenerate migration SQL
after a schema change).

## The three database roles

| Role | Env var | Where | Access |
|------|---------|-------|--------|
| **owner** | `DATABASE_URL` | local / CI only | everything — migrations + seed |
| **app** | `DATABASE_URL` *in Vercel* | Vercel env only | read/write all tables incl. auth |
| **agent** | `AGENT_DATABASE_URL` | local CLI / agents | `projects` + `tasks` + `runs` + `events`; **no auth tables** |

Create the scoped agent role once (psql as owner):

```sql
CREATE ROLE mc_agent LOGIN PASSWORD '…';
GRANT USAGE ON SCHEMA public TO mc_agent;
GRANT SELECT, INSERT, UPDATE, DELETE ON projects, tasks TO mc_agent;
-- Mission Control: runs/events are append-only / update-only — no DELETE. events.seq is a
-- GENERATED-AS-IDENTITY column, so table INSERT suffices (no sequence grant needed).
GRANT SELECT, INSERT, UPDATE ON runs, events TO mc_agent;
REVOKE ALL ON users, sessions, accounts, verification FROM mc_agent;
```

> The `0001_*` migration also applies the `runs`/`events` grant automatically — **but only if the
> `mc_agent` role already exists** (it's guarded by a `pg_roles` check). On a DB where the role is
> created later, run the `GRANT … ON runs, events` above as part of this one-time setup.

After any future migration that adds an agent-facing table, re-run the `GRANT` (or set
`ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO mc_agent;`).

## CLI (for agents)

Requires the scoped `AGENT_DATABASE_URL`. It does **not** silently fall back to `DATABASE_URL`
(which may be the owner role) — with only `DATABASE_URL` set, `mc` refuses to run (exit 4) unless
you opt in with `MC_ALLOW_DATABASE_URL_FALLBACK=1` (not recommended). See [`cli/README.md`](cli/README.md).

```bash
npm run cli -- project list --json
npm run cli -- task add my-project "Wire up billing"
npm run cli -- integration set my-project sentry done
```

Beyond the project/task catalog, the CLI also drives **Mission Control** — agent runs, the
activity-event log, and the cost rollup — plus self-dispatch (`task next`/`task claim`) and
self-sourcing (`task import-issues`):

```bash
npm run cli -- run list --active --json          # what's running right now
npm run cli -- task next --json                  # next claimable task (FIFO)
npm run cli -- spend --group-by agent --json     # cost rollup, by agent
```

The full command catalog (every flag, with `readonly` tags) is in [`cli/README.md`](cli/README.md)
and at runtime via `mc spec --json`.

## Security model

- Sign-in is Google OAuth, restricted to `you@example.com`, enforced **both** at user-creation
  (`databaseHooks.user.create.before`, fail-closed) and per-request (`requireAllowedUser()` in
  every server action and the dashboard page). Middleware is only a redirect convenience, not
  the security boundary.
- **Threat model for `AGENT_DATABASE_URL`:** anyone holding it can read/write all project and
  task data and bypasses the email allowlist for the write path. It **cannot** read sessions or
  accounts (auth tables are revoked). Treat it as a sensitive credential; never set it in Vercel.

## Deploying to Vercel

- Set in Vercel (Production): `DATABASE_URL` (the **app** role, not owner), `BETTER_AUTH_SECRET`,
  `BETTER_AUTH_URL` + `NEXT_PUBLIC_BETTER_AUTH_URL` (prod origin), `GOOGLE_CLIENT_ID/SECRET`,
  `ALLOWED_EMAIL`. Do **not** set `AGENT_DATABASE_URL` or the owner string there.
- Add the production callback to Google Cloud authorized redirect URIs:
  `https://<prod-domain>/api/auth/callback/google`.
- Node is pinned to 22.x via `engines` in `package.json`.
- For future schema changes: run `npm run db:migrate` (owner, local/CI) and re-grant the agent
  role **before** promoting code that depends on the new schema.

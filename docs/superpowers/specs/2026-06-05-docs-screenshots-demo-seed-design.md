# Docs screenshots + demo seed — design

**Date:** 2026-06-05
**Status:** Approved
**Branch:** `docs/screenshots-demo-seed`

## Goal

Add real UI screenshots to the Mission Control docs (`docs/`, a Holocron MDX site) so
readers can see the product, not just read about it. Screenshots must show a **fictional
demo dataset** — never real client/TICC project data — because this is the public OSS repo.

## Decisions (locked)

- **Demo data home:** a dedicated Neon branch `demo` (parented off `dev`), fully isolated
  from dev/prod. Created via `neonctl`. Connection in gitignored `.env.demo`.
  - Branch id `br-weathered-poetry-ap2jsmme`, endpoint `ep-muddy-haze-apje19tl`.
- **Coverage:** comprehensive — ~14 screenshots across the screenshot-worthy doc pages.
- **Theme:** fictional indie software studio, **"Northwind Labs"**.
- **Seed mechanism:** a reusable, deterministic TypeScript script `scripts/seed-demo.ts`
  (writes via the owner DB layer; the `mc` agent role can't write workflows/profiles/mcp).

## Components

### 1. Demo branch (done)

`.env.demo` (gitignored) holds `DATABASE_URL` (owner) + `AGENT_DATABASE_URL` (mc_agent),
both pointed at the `demo` endpoint. The branch inherited real data on creation; it gets
truncated + reseeded before any screenshot.

### 2. Schema migration

The `dev` parent is behind HEAD (10 of 21 migrations). Run `db:migrate` against the demo
branch to apply `0010`→`0020`, creating `workflows`, `workflow_runs`, `workflow_step_runs`,
`mcp_connections`, `composio_toolkits`. `drizzle.config.ts` loads `.env.local` via dotenv
*without* overriding pre-set env, so `DATABASE_URL=<demo-owner> npm run db:migrate` targets
the demo branch.

### 3. `scripts/seed-demo.ts`

Idempotent + deterministic (fixed UUIDs/slugs → identical screenshots on re-run).

- **Safety guard:** refuses to run unless `DATABASE_URL`'s host contains the demo endpoint
  id (`ep-muddy-haze-apje19tl`). This makes the truncate physically unable to hit dev/prod.
- **Truncate** the app/working tables (projects, tasks, runs, events, agent_profiles,
  workflows, workflow_runs, workflow_step_runs, mcp_connections, composio_toolkits) —
  `TRUNCATE ... RESTART IDENTITY CASCADE`. Never touches auth tables (users/accounts/
  sessions/verification/settings).
- **Seed "Northwind Labs":**
  - **~6 projects** across categories/accents/priorities/statuses: *Habitcraft* (consumer
    app), *Dispatch* (newsletter SaaS), *Northwind Site* (marketing web), *Atlas API*
    (internal infra), *Pixel Press* (blog), one archived.
  - **Tasks** per project spread across todo / in_progress / done, a couple claimed,
    sensible `sort_order` for the board.
  - **~20 runs** with mixed statuses (completed/failed/running), realistic token + cost
    values, timestamps spread over the last several days, agent labels/models — plus the
    **events** they imply so the Overview + Mission feeds populate.
  - **3–4 agent profiles** (builder / researcher / nightly check-in / exec) with match rules.
  - **MCP connections:** a Composio "linear" (active) + one remote server, on a project, so
    the MCP tab renders both source types.
  - **1–2 workflows** with a real graph (trigger → agent → branch → gate/integration) and
    run + step-run history so the canvas and run-status pages render.

### 4. Capture

Run `npm run dev` with the demo env. The user signs in once locally (the one auth step that
can't be automated). Screenshots driven through that browser session at a **fixed viewport
(1440×900, 2× scale)**, consistent theme, saved to `docs/public/screenshots/<name>.png`.

### 5. Docs edits (~14 shots)

Embed each in the relevant page using the existing `<Frame caption="…">` convention; keep
the conceptual SVG figures (screenshots complement them). Mapping:

| Screenshot | Page(s) |
|---|---|
| Overview dashboard (hero) | `index.mdx`, `overview.mdx`; refresh `dashboard.mdx` `live-view.png` |
| Projects table | `dashboard.mdx` |
| Board (kanban swimlanes) | `dashboard.mdx` |
| Project detail — Overview / Tasks tabs | `data-model.mdx` |
| MCP tab | `mcp.mdx` |
| Workflows canvas + run status | `workflows.mdx` |
| Run detail (metrics + event trail) | `telemetry.mdx`, `autonomy.mdx` |
| Mission live feed + runs strip | `autonomy.mdx` |
| Profiles list + detail | `profiles.mdx` |
| Spend page | `cost.mdx` |

Reference pages (`cli`/`schema`/`api`/`operating`) stay text-only.

### 6. Review

Placement, captions, alt text; run the docs dev server to verify rendering; open a PR.

## Out of scope

- No changes to the app itself.
- No `mc` CLI seeding path (agent role can't cover workflows/profiles/mcp).
- Reference pages stay text-only.

## Teardown / reuse

`scripts/seed-demo.ts` is committed and reusable: anyone who points `DATABASE_URL` at the
demo branch (or their own throwaway branch matching the guard) can reproduce the dataset to
re-shoot screenshots. The demo branch can be kept for future captures or deleted via
`neonctl branches delete`.

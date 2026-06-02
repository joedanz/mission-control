# Overview: replace Integration Status Board with a Live Fleet glance

**Date:** 2026-06-02
**Status:** Approved (design)
**Scope:** One slice. First of several that move integration data off the Overview page. The
remaining slices (live Errors/Sentry tab, live Email/Zoho tab, conditional Stripe tab) get their
own spec → plan → build cycles and are **not** covered here.

## Problem

The Overview route (`app/(sections)/page.tsx`) renders an "Integration Status Board" — two
`Matrix` widgets showing per-project Sentry (error-tracking) and Zoho (email) setup status. That
integration-setup status is the wrong altitude for the portfolio landing page, and it is already
surfaced where it belongs:

- the project list already has per-row **SEN** / **ZOH** status columns
  (`components/ProjectRow.tsx` via `integrationStatusOf`), and
- the project detail page already has an **Integrations** tab (`app/p/[slug]/page.tsx`).

So the Overview matrices are redundant. The freed slot should show a portfolio-level **live
glance of the agent fleet** — the most on-brand content for a "control room for the fleet of AI
assistants" — and link to the full Mission view.

## Goal

New Overview reads top-to-bottom as: **Stat strip → Fleet (live) → Recently Active**.

## Non-goals

- Do **not** delete the Sentry/Zoho data model. Integration *tasks*, the per-row SEN/ZOH columns,
  and the detail-page Integrations tab stay untouched. Only the Overview matrices are removed.
- Do **not** refactor `ActivityFeed`'s inline copy of the Fleet strip (it duplicates `FleetRail`
  markup). Pre-existing, unrelated to this slice.
- No new external integrations, API routes, credentials, or schema changes.

## Design

### New component: `components/FleetGlance.tsx` (client island)

```tsx
'use client';
import { useActivityFeed } from '@/lib/useActivityFeed';
import { FleetRail } from '@/components/FleetRail';

const GLANCE_LIMIT = 6; // matches Recently Active's slice(0, 6)

export function FleetGlance() {
  const { runs, loaded } = useActivityFeed();
  return (
    <>
      <FleetRail runs={runs.slice(0, GLANCE_LIMIT)} loaded={loaded} />
      <a className="section-action" href="/mission">View all in Mission →</a>
    </>
  );
}
```

- Reuses the **existing extracted** `FleetRail` strip, so rows render identically to Mission and
  the boards (no new run-row markup).
- Reuses the existing data seam `useActivityFeed()` (4s poll of `/api/activity`); when that seam
  moves to SSE later, this component changes nothing.
- Caps to `GLANCE_LIMIT = 6` for a glance. **Known caveat:** `FleetRail`'s "N live" header counts
  only the passed slice. Acceptable because runs are ordered by `lastHeartbeatAt` desc and live
  runs heartbeat most recently, so they sort to the top of the first 6 in practice.
- `section-action` is an existing/legible link style; if no suitable class exists, add a minimal
  one in `globals.css` during implementation (confirm by grep first; reuse if present).

### `app/(sections)/page.tsx`

- Remove the `Matrix` import and the `Integration Status Board` `<h2>` + `<div className="matrices">`
  block (current lines ~52–56).
- Insert `<FleetGlance />` in that slot.
- Keep the stat strip and the `RecentActivity` block.
- Change the dashboard destructure from `{ all, stats, sentry, zoho, aliasesNote }` to `{ all, stats }`.

### `lib/queries.ts` cleanup (the Overview was the only consumer)

Confirmed by grep: `getDashboard` / `IntegrationGrid` / `integrationGrid` / `.sentry` / `.zoho` /
`aliasesNote` / `Matrix` appear only in `lib/queries.ts`, `app/(sections)/page.tsx`, and
`components/Matrix.tsx`. No tests, CLI, or other consumers.

- Drop `sentry`, `zoho`, `aliasesNote` from `getDashboard()`'s return value and from the
  `Dashboard` type.
- Remove the `integrationGrid()` helper and the `IntegrationGrid` / `IntegrationRow` types.
- Remove the now-dead `settings` / `email_aliases` read and its `settings` import (if `settings`
  is unused elsewhere in the file after this).
- Keep `stats`, `all`, and `byCategory` intact.
- **Leave** the `email_aliases` settings row and `ZOHO_EMAIL_LOCALPART` env in place — the future
  Email-tab slice may consume them.

### Delete `components/Matrix.tsx`

Only the Overview imported it.

## Data flow

Unchanged seam. The Overview remains a Server Component (`getDashboard()` for stats + recent) with
a single client island for live runs:

```
FleetGlance (client) → useActivityFeed() → GET /api/activity (4s poll) → FleetRail
```

No new server fetch, no new endpoint.

## Error / empty states

Inherited from `FleetRail`:
- not yet loaded → "Loading…"
- loaded, no runs → "No runs yet."
- `useActivityFeed` `error` is non-fatal — the strip keeps showing the last good data (same as
  Mission today).

## Verification

The repo has **no component/jsdom test infrastructure** — every test is node-environment and runs
against the real Neon DB (`vitest.config.ts`). Adding React component tests for one presentational
island is out of proportion (YAGNI). Verify instead via:

1. **TypeScript** — removing `sentry`/`zoho`/`aliasesNote` from the `Dashboard` type makes the
   compiler flag any stray consumer. `tsc` must pass clean.
2. **Lint** — `npm run lint` (the repo's lint script is `eslint`; there is no biome here).
3. **Build** — `next build` succeeds.
4. **Browser dogfood of `/`** — Fleet glance renders and polls live, the Sentry/Zoho matrices are
   gone, "View all in Mission →" links to `/mission`, and Recently Active is intact. Confirm the
   empty state when there are no runs.

## Files touched

| File | Change |
|------|--------|
| `components/FleetGlance.tsx` | **new** — client glance wrapping `FleetRail` |
| `app/(sections)/page.tsx` | remove matrices + `Matrix` import; add `<FleetGlance />`; trim destructure |
| `lib/queries.ts` | drop sentry/zoho/aliasesNote + `integrationGrid` + grid types + settings read |
| `components/Matrix.tsx` | **delete** |
| `app/globals.css` | only if a `section-action` link style must be added |

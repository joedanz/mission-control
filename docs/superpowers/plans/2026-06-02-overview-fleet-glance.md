# Overview Fleet-Glance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Overview route's Sentry/Zoho "Integration Status Board" with a live Fleet glance that reuses the existing `FleetRail` strip and links to `/mission`.

**Architecture:** The Overview (`app/(sections)/page.tsx`) stays a Server Component for stats + recent projects, and gains one client island (`FleetGlance`) that subscribes to the existing `useActivityFeed()` poll and renders `FleetRail`. The now-orphaned Sentry/Zoho grid code in `lib/queries.ts` and `components/Matrix.tsx` is removed.

**Tech Stack:** Next.js (App Router, RSC + client islands), TypeScript, Drizzle (Neon), the existing `useActivityFeed` / `FleetRail` components.

**Branch:** `feat/overview-fleet-glance` (already created and checked out).

---

## Testing note (read before starting)

This repo has **no component / jsdom test harness** — every file under `test/` is a node-environment, real-Neon-DB integration test (`vitest.config.ts`, `environment: 'node'`). The approved spec (`docs/superpowers/specs/2026-06-02-overview-fleet-glance-design.md`) explicitly rules out adding component-test infrastructure for one presentational island (YAGNI). So this plan's verification gates are **TypeScript, ESLint, `next build`, and a browser dogfood** — not new `*.test.ts` files. Do **not** fabricate jsdom/@testing-library tests; that would contradict the spec and the repo's conventions. The type system is the primary safety net: trimming the `Dashboard` type makes the compiler flag any stray consumer.

Typecheck command used throughout: `npx tsc --noEmit` (Expected: no output, exit 0).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `components/FleetGlance.tsx` | Client island: live Fleet glance for the Overview slot (wraps `FleetRail`, caps to 6 runs, links to `/mission`) | **Create** |
| `app/globals.css` | Add a minimal `.section-action` link style for the "View all" link | **Modify** (append) |
| `app/(sections)/page.tsx` | Remove the Integration Status Board; mount `<FleetGlance />`; trim the dashboard destructure | **Modify** |
| `lib/queries.ts` | Drop the Sentry/Zoho grid code, types, and the `email_aliases` read from `getDashboard()` | **Modify** |
| `components/Matrix.tsx` | The Sentry/Zoho matrix widget — only the Overview used it | **Delete** |

---

## Task 1: FleetGlance component + link style

**Files:**
- Create: `components/FleetGlance.tsx`
- Modify: `app/globals.css` (append a `.section-action` rule)

- [ ] **Step 1: Create the component**

Create `components/FleetGlance.tsx` with exactly this content:

```tsx
'use client';

// ABOUTME: Overview's live "Fleet" glance — the same FleetRail strip the Mission tab renders,
// ABOUTME: capped to a handful of runs, with a link out to the full /mission view.

import { useActivityFeed } from '@/lib/useActivityFeed';
import { FleetRail } from '@/components/FleetRail';

// Matches the Overview's Recently Active slice(0, 6) so the two sections feel balanced.
const GLANCE_LIMIT = 6;

export function FleetGlance() {
  const { runs, loaded } = useActivityFeed();
  return (
    <>
      <FleetRail runs={runs.slice(0, GLANCE_LIMIT)} loaded={loaded} />
      <a className="section-action" href="/mission">
        View all in Mission →
      </a>
    </>
  );
}
```

- [ ] **Step 2: Append the link style to `app/globals.css`**

Add this rule at the end of `app/globals.css`:

```css
/* "View all →" style link under a section glance (e.g. the Overview Fleet glance). */
.section-action {
  display: inline-block;
  margin-top: var(--space-sm, 8px);
  font-family: var(--font-mono);
  font-size: var(--fs-11, 11px);
  color: var(--ink-mute, #888);
  text-decoration: none;
}
.section-action:hover {
  text-decoration: underline;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output, exit 0. (`FleetGlance` is not yet imported anywhere — that's fine; it must still compile.)

- [ ] **Step 4: Commit**

```bash
git add components/FleetGlance.tsx app/globals.css
git commit -m "feat(overview): add FleetGlance client island + section-action link style"
```

---

## Task 2: Mount FleetGlance on the Overview, remove the Integration Status Board

**Files:**
- Modify: `app/(sections)/page.tsx`

- [ ] **Step 1: Remove the `Matrix` import**

Delete this line (currently line 7):

```tsx
import { Matrix } from '@/components/Matrix';
```

Add this import next to the other component imports (after the `RecentActivity` import line):

```tsx
import { FleetGlance } from '@/components/FleetGlance';
```

- [ ] **Step 2: Trim the dashboard destructure**

Change this line (currently line 20):

```tsx
  const { all, stats, sentry, zoho, aliasesNote } = await getDashboard();
```

to:

```tsx
  const { all, stats } = await getDashboard();
```

- [ ] **Step 3: Replace the Integration Status Board block with the Fleet glance**

Find this block (currently lines 52–56):

```tsx
      <h2 className="section-sublabel">Integration Status Board</h2>
      <div className="matrices">
        <Matrix title="Sentry — Error Tracking" grid={sentry} open />
        <Matrix title="Zoho — Email Setup" grid={zoho} note={aliasesNote} open />
      </div>
```

Replace it with:

```tsx
      <FleetGlance />
```

(`FleetRail`, rendered inside `FleetGlance`, supplies its own `Fleet · N live` heading, so no separate `<h2>` is needed here.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output, exit 0. (`getDashboard` still returns `sentry`/`zoho`/`aliasesNote`; the page simply no longer destructures them — that compiles. Those fields are removed in Task 3.)

- [ ] **Step 5: Build**

Run: `npx next build`
Expected: build completes successfully; `/` is listed in the route output.

- [ ] **Step 6: Commit**

```bash
git add "app/(sections)/page.tsx"
git commit -m "feat(overview): swap Integration Status Board for the live Fleet glance"
```

---

## Task 3: Remove the orphaned Sentry/Zoho grid code from `lib/queries.ts`

**Files:**
- Modify: `lib/queries.ts`

Context: after Task 2 nothing consumes `getDashboard().sentry`, `.zoho`, or `.aliasesNote`. Confirmed by grep that `IntegrationGrid` / `IntegrationRow` / `integrationGrid` are referenced only in `lib/queries.ts` and `components/Matrix.tsx` (deleted in Task 4).

- [ ] **Step 1: Remove the `settings` import**

In the schema import block near the top of the file, remove the `settings,` line (currently line 9). The remaining imports (`projects`, `tasks`, `runs`, `events`, `agentProfiles`, the `EVENT_LEVELS` / type imports) stay.

- [ ] **Step 2: Delete the `IntegrationRow` and `IntegrationGrid` type exports**

Delete these two type blocks (currently lines 36–47):

```ts
export type IntegrationRow = {
  projectId: string;
  projectName: string;
  label: string; // grid display label (project name, or <localpart>@domain for zoho)
  status: string; // needed | pending | done
};

export type IntegrationGrid = {
  rows: IntegrationRow[];
  done: number;
  total: number; // live count of projects that have this integration task
};
```

- [ ] **Step 3: Trim the `Dashboard` type**

Change the `Dashboard` type (currently lines 57–69) to drop the three integration fields:

```ts
export type Dashboard = {
  /** Flat, ordered (sortOrder, name) project list — the single source for the unified table. */
  all: ProjectWithTasks[];
  byCategory: {
    internal: ProjectWithTasks[];
    open_source: ProjectWithTasks[];
    client: ProjectWithTasks[];
  };
  stats: DashboardStats;
};
```

- [ ] **Step 4: Delete the `integrationGrid` helper**

Delete the entire `integrationGrid(...)` function (currently lines 531–555 — the block starting `function integrationGrid(` and ending at its closing `}` before `export async function getDashboard`).

- [ ] **Step 5: Trim `getDashboard()`**

Replace the whole `getDashboard` function (currently lines 557–588) with:

```ts
export async function getDashboard(): Promise<Dashboard> {
  const all = await getProjectsWithTasks();

  const byCategory = {
    internal: all.filter((p) => p.category === 'internal'),
    open_source: all.filter((p) => p.category === 'open_source'),
    client: all.filter((p) => p.category === 'client'),
  };

  const stats: DashboardStats = {
    total: all.length,
    prelaunch: all.filter((p) => p.status === 'prelaunch').length,
    launched: all.filter((p) => p.status === 'launched').length,
    client: byCategory.client.length,
    openSource: byCategory.open_source.length,
  };

  return { all, byCategory, stats };
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output, exit 0. (If tsc reports `settings` is still used or any removed type is still referenced, that surfaces a consumer the grep missed — stop and reconcile before continuing.)

- [ ] **Step 7: Commit**

```bash
git add lib/queries.ts
git commit -m "refactor(queries): drop Sentry/Zoho dashboard grids now that the Overview is fleet-first"
```

---

## Task 4: Delete the now-unused Matrix component

**Files:**
- Delete: `components/Matrix.tsx`

- [ ] **Step 1: Confirm nothing imports Matrix**

Run: `grep -rn "components/Matrix\|{ Matrix }\|<Matrix" app components lib cli`
Expected: no matches (Task 2 removed the only import).

- [ ] **Step 2: Delete the file**

```bash
git rm components/Matrix.tsx
```

- [ ] **Step 3: Typecheck + lint + build**

Run: `npx tsc --noEmit`
Expected: no output, exit 0.

Run: `npm run lint`
Expected: eslint passes with no errors (the repo's lint script is `eslint`; there is no biome here).

Run: `npx next build`
Expected: build completes successfully.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(overview): remove orphaned Matrix component"
```

---

## Task 5: Browser dogfood + final verification

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server**

Run: `npm run dev` (serves on http://localhost:3030).

- [ ] **Step 2: Sign in and open the Overview**

The Overview is auth-gated (`requireAllowedUser()` → redirects to `/login`). Sign in with an allow-listed account, then visit http://localhost:3030/.

- [ ] **Step 3: Verify the Overview visually**

Confirm all of:
- The stat strip still renders at the top.
- A **Fleet** section (`Fleet · N live`) renders where the Sentry/Zoho matrices used to be, listing recent agent runs (or the `No runs yet.` / `Loading…` empty state when there are none).
- A **"View all in Mission →"** link appears under the Fleet strip and navigates to `/mission`.
- **Recently Active** still renders below.
- The old "Integration Status Board" / Sentry / Zoho matrices are **gone**.

- [ ] **Step 4: Confirm integration data is untouched elsewhere**

- Visit `/projects` (or `/`): the project rows still show the **SEN** / **ZOH** status cells.
- Open a project detail page (`/p/<slug>`): the **Integrations** tab still lists its integration tasks.

(These prove the slice only removed the Overview matrices, not the integration data model.)

- [ ] **Step 5: Final plan-complete check**

Confirm the full gate one more time from a clean state:

Run: `npx tsc --noEmit && npm run lint && npx next build`
Expected: all three succeed.

The branch `feat/overview-fleet-glance` now contains four commits (component+style, page swap, queries trim, Matrix delete). Stop here — opening a PR / merging is a separate, user-initiated step.

---

## Self-Review (completed during authoring)

- **Spec coverage:** Every spec item maps to a task — FleetGlance (T1), page swap + destructure trim (T2), queries.ts cleanup incl. `settings`/`email_aliases` removal (T3), Matrix deletion (T4), verification incl. "integration data untouched" (T5). The spec's "leave `email_aliases` row + `ZOHO_EMAIL_LOCALPART` env" is honored: T3 removes only the *read* in `getDashboard`, not the settings row or env.
- **Placeholder scan:** No TBD/TODO/"handle errors"/vague steps; every code step shows complete code and every command shows expected output.
- **Type consistency:** `FleetGlance` (no props) is used as `<FleetGlance />`; `useActivityFeed()` returns `{ runs, loaded }` (matches `lib/useActivityFeed.ts`); `FleetRail` takes `{ runs, loaded }` (matches `components/FleetRail.tsx`); `Dashboard` keeps `all` / `byCategory` / `stats` and the trimmed `getDashboard` returns exactly those three.

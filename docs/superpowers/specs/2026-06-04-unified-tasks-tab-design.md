# Unified Tasks Tab — List ⇄ Board Toggle

**Date:** 2026-06-04
**Status:** Approved (design)
**Area:** Project detail page (`/p/[slug]`)

## Problem

The project detail page has two separate tabs — **Tasks** and **Board** — that render the
*same* dataset (`project.tasks.filter(t => !t.integrationType)`, i.e. custom non-integration
tasks) in two different ways:

- **Tasks** — a flat `<ul>` list: add, check-off (todo↔done), delete. Server-rendered; updates
  on revalidate.
- **Board** — a kanban (dnd-kit) with three status columns: drag between columns (status),
  drag within a column (reorder via `sortOrder`), live-claim badges + run links. Client-side,
  polls `/api/board?project=<slug>` every ~4s via `useBoard()`.

They share one `Task` model (`lib/db/schema.ts`), one mutation core (`lib/mutations.ts` →
`app/actions.ts`), and the same `getProjectBySlug` fetch. The split is purely presentational,
and surfacing the same tasks under two tabs is redundant.

## Goal

Collapse the two tabs into a single **Tasks** tab containing a **List ⇄ Board** view toggle,
so the same tasks are reachable one place with two presentations, and switching between the two
is always consistent.

## Decisions (from brainstorming)

1. **Roles:** List = quick triage (add / check-off / delete). Board = full workflow (3 statuses,
   drag-reorder, live-claim badges). Each view keeps the capabilities it has today — the Board
   gains nothing, and the List gains no drag/status/claim affordances.
2. **Toggle placement/style:** an inline pill switch directly **under** the tab, left-aligned
   (`≣ List | ▥ Board`) — reads like a second row of mini-tabs.
3. **Default + persistence:** default view is **List**. The chosen view persists in
   `localStorage` under a **per-project** key (some projects you triage as a list, others you
   run as a board), following the same `localStorage` mechanism the Board's done-window filter
   already uses.
4. **Single live data source:** both views read the same live `useBoard()` data so toggling is
   always consistent (drag a task to *done* on the Board, flip to List, it shows as done — no
   stale snapshot).

## UX Behavior

- The standalone **"Board" tab is removed**; one **"Tasks"** tab remains in the tab bar.
- Inside the Tasks tab, an inline pill switch (`≣ List | ▥ Board`) sits below the tab,
  left-aligned. Touch-sized for mobile.
- **Default = List.** Selection is written to a **per-project** `localStorage` key
  `mc:taskView:<slug>` (values `'list' | 'board'`); each project remembers its own view.
- **Legacy deep-links:** a visit to `?tab=board` resolves to the **Tasks** tab with the
  **Board** view shown — a one-time override of the stored preference — so existing
  bookmarks/links keep working. (No new `?view=` param; this is the only URL affordance.)
- **Empty state:** the List view shows "No tasks yet." plus the add input. The Board view shows
  its empty columns as today.

## Architecture

### Files

- `app/p/[slug]/page.tsx` (modify)
  - Remove the separate `tasks` and `board` tab entries.
  - Add one `tasks` entry whose content is a new client wrapper:
    `<TasksPanel slug={project.slug} projectId={project.id} initial={boardInitial}
    integrations={boardIntegrations} />`.
  - The server still computes `boardInitial` (`toBoardProject(project, false)`) and the
    integration counts and passes them down — **no extra fetch**.

- `components/TasksPanel.tsx` (new, client)
  - Owns the pill switch, per-project `localStorage` persistence (`mc:taskView:<slug>`), and the legacy
    `?tab=board` read (which forces the board view on first paint).
  - Renders either `<TaskListView>` or `<ProjectBoard>` from the same props.

- `components/TaskListView.tsx` (new, client)
  - The live list. Renders `TaskItem` rows + `AddTask`, fed from the shared hook (not server
    props). Shows the empty state when there are no custom tasks.

- `components/board/ProjectBoard.tsx` (unchanged) — rendered by `TasksPanel` for the board view.

- `components/TaskItem.tsx`, `components/AddTask.tsx` (reused as-is) — same server actions.

### Data flow

- `TaskListView` consumes the **same `useBoard()` hook** the Board uses. Its `BoardTask`
  projection (custom tasks only, with `status`/`sortOrder`/`version`/claim fields) is already the
  right shape; the list only reads `id`, `label`, `notes`, and `status`.
- Mutations stay on the existing server actions (`addTask` / `toggleTask` / `deleteTask`) — no
  new mutation paths.
- "Done" in the list = `status === 'done'`. The check-off toggle flips todo↔done via the
  unchanged `toggleTask` action.
- To avoid ~4s poll lag on the user's own clicks, the list triggers an immediate refetch from
  `useBoard` after a mutation. If `useBoard` does not already expose a refetch, extend it with a
  small `refresh()` that re-hits `/api/board` (confirmed during planning).

## Edge Cases

- **Toggling consistency:** a Board-side status change is visible in the List immediately on
  switch (shared live source).
- **Mobile:** List is the default (no drag needed); pill switch is touch-sized.
- **Live-claimed tasks in the List:** existing behavior is preserved — the current Tasks list
  already allows toggle/delete regardless of claim state; this design does **not** change that.
  (Locking claimed tasks in the List is explicitly out of scope.)
- **localStorage unavailable / first visit:** fall back to the default (List).

## Out of Scope (YAGNI)

- No add/delete affordances on the Board.
- No drag, status control, or claim badges in the List.
- No new URL param for the view beyond the legacy `?tab=board` resolution.
- No change to claim-locking behavior for list mutations.

## Testing

- **Persistence + legacy URL** (`TasksPanel`): default is List; selecting Board writes
  `mc:taskView:<slug>`; a subsequent mount for that slug reads it back; a different slug is
  unaffected (per-project scoping); `?tab=board` forces the board view once.
- **Consistency:** a status change applied through the Board path is reflected in the List view
  after toggling (shared `useBoard` source).
- **List mutations:** add / check-off / delete still call their server actions and the list
  refreshes promptly (immediate refetch, not the 4s poll).
- Existing Board tests continue to pass unchanged (Board is untouched).

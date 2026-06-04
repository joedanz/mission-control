# Unified Tasks Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the project detail page's separate "Tasks" and "Board" tabs into one **Tasks** tab with a List ⇄ Board view toggle, where both views read the same live data.

**Architecture:** A new client wrapper `TasksPanel` renders a per-project-persisted pill toggle and switches between a new live `TaskListView` (reuses `TaskItem`/`AddTask`, fed by the existing `useBoard` poll hook) and the unchanged `ProjectBoard`. Pure logic (view resolution, list projection, tab-alias resolution) is extracted into `lib/` and unit-tested; React wiring is verified by typecheck/lint + manual browser check. Legacy `?tab=board` links resolve to the Tasks tab/Board view via a new `aliases` prop on `TabbedPanels`.

**Tech Stack:** Next.js (App Router, this repo's custom build — see `AGENTS.md`), React client components, `@dnd-kit` (board, untouched), Vitest (node env, pure-logic tests), plain CSS in `app/globals.css`.

**Conventions learned from the codebase (do not deviate):**
- Tests are **node-env, pure-logic** (`test/*.test.ts`, run with `vitest run`). There is **no DOM/RTL harness** — do NOT add one. Test pure functions in `lib/`.
- localStorage preference keys use dot notation per project: existing `mc.board.doneWindow.${slug}`. We mirror it with `mc.taskView.${slug}`.
- The "render default on first paint, read localStorage in an effect" pattern (see `ProjectBoard.tsx:68-76`) avoids SSR hydration mismatch. Follow it exactly.
- `useBoard` (`lib/useBoard.ts`) returns `{ projects, runs, loaded, error, reload, applyMove }`. `reload` is the immediate refetch.

---

## File Structure

**Create:**
- `lib/tabs.ts` — pure `resolveActiveTab(fromUrl, keys, aliases)` for the tab switcher.
- `lib/task-view.ts` — pure view helpers: `TaskView` type, `taskViewStorageKey`, `parseTaskView`, `resolveInitialTaskView`, `toListRows`.
- `components/TaskListView.tsx` — client live list (reuses `TaskItem` + `AddTask`, fed by `useBoard`).
- `components/TasksPanel.tsx` — client wrapper: pill toggle + per-project persistence + legacy `?tab=board`, renders list or board.
- `test/tabs.test.ts` — unit tests for `resolveActiveTab`.
- `test/task-view.test.ts` — unit tests for the view helpers.

**Modify:**
- `components/TabbedPanels.tsx` — add optional `aliases` prop; use `resolveActiveTab`.
- `components/TaskItem.tsx` — add optional `onChanged?: () => void` (fires after the mutation resolves).
- `components/AddTask.tsx` — add optional `onAdded?: () => void`.
- `app/p/[slug]/page.tsx` — drop the two separate tab entries; add one `tasks` tab rendering `<TasksPanel>`; pass `aliases={{ board: 'tasks' }}` to `TabbedPanels`; remove now-unused imports/vars.
- `app/globals.css` — add `.view-toggle` segmented-control styles.

---

## Task 1: Pure tab-alias resolver

**Files:**
- Create: `lib/tabs.ts`
- Test: `test/tabs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/tabs.test.ts
// ABOUTME: Unit tests for resolveActiveTab — the URL-tab → active-key resolver behind TabbedPanels,
// ABOUTME: including alias mapping (legacy ?tab=board → tasks) and fallback to the first tab.

import { describe, it, expect } from 'vitest';
import { resolveActiveTab } from '../lib/tabs';

const KEYS = ['overview', 'tasks', 'workflows'];

describe('resolveActiveTab', () => {
  it('returns the url tab when it is a known key', () => {
    expect(resolveActiveTab('tasks', KEYS)).toBe('tasks');
  });

  it('falls back to the first tab when the url tab is unknown', () => {
    expect(resolveActiveTab('nope', KEYS)).toBe('overview');
  });

  it('falls back to the first tab when there is no url tab', () => {
    expect(resolveActiveTab(null, KEYS)).toBe('overview');
  });

  it('maps an aliased url tab to its target key', () => {
    expect(resolveActiveTab('board', KEYS, { board: 'tasks' })).toBe('tasks');
  });

  it('ignores an alias whose target is not a known key', () => {
    expect(resolveActiveTab('board', ['overview'], { board: 'tasks' })).toBe('overview');
  });

  it('prefers a real key over an alias of the same name', () => {
    expect(resolveActiveTab('tasks', KEYS, { tasks: 'overview' })).toBe('tasks');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tabs.test.ts`
Expected: FAIL — `Cannot find module '../lib/tabs'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// lib/tabs.ts
// ABOUTME: Pure resolver for the project detail tab switcher: maps the ?tab= URL value to an active
// ABOUTME: tab key, honoring an optional alias map (e.g. legacy 'board' → 'tasks') and falling back
// ABOUTME: to the first tab. No React — unit-testable in isolation.

export function resolveActiveTab(
  fromUrl: string | null | undefined,
  keys: string[],
  aliases: Record<string, string> = {},
): string {
  if (fromUrl && keys.includes(fromUrl)) return fromUrl;
  if (fromUrl) {
    const target = aliases[fromUrl];
    if (target && keys.includes(target)) return target;
  }
  return keys[0];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/tabs.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/tabs.ts test/tabs.test.ts
git commit -m "feat: pure resolveActiveTab with tab-alias support"
```

---

## Task 2: Pure task-view helpers

**Files:**
- Create: `lib/task-view.ts`
- Test: `test/task-view.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/task-view.test.ts
// ABOUTME: Unit tests for the unified Tasks-tab view helpers — storage-key shape, view parsing,
// ABOUTME: initial-view resolution (legacy ?tab=board override + stored pref + default), and the
// ABOUTME: BoardTask → list-row projection. Pure (no DOM / no DB).

import { describe, it, expect } from 'vitest';
import {
  taskViewStorageKey,
  parseTaskView,
  resolveInitialTaskView,
  toListRows,
} from '../lib/task-view';
import type { BoardTask } from '../lib/board';

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 't1', label: 'Task', notes: null, status: 'todo', sortOrder: 0,
    projectId: 'p1', claimedByRunId: null, version: 0, completedAt: null,
    ...overrides,
  };
}

describe('taskViewStorageKey', () => {
  it('is per-project and dot-namespaced', () => {
    expect(taskViewStorageKey('acme')).toBe('mc.taskView.acme');
    expect(taskViewStorageKey('beta')).not.toBe(taskViewStorageKey('acme'));
  });
});

describe('parseTaskView', () => {
  it('accepts the two valid views', () => {
    expect(parseTaskView('list')).toBe('list');
    expect(parseTaskView('board')).toBe('board');
  });
  it('rejects anything else as null', () => {
    expect(parseTaskView('grid')).toBeNull();
    expect(parseTaskView(null)).toBeNull();
    expect(parseTaskView(undefined)).toBeNull();
  });
});

describe('resolveInitialTaskView', () => {
  it('defaults to list with no stored pref', () => {
    expect(resolveInitialTaskView({})).toBe('list');
  });
  it('uses the stored pref when valid', () => {
    expect(resolveInitialTaskView({ stored: 'board' })).toBe('board');
  });
  it('ignores an invalid stored pref', () => {
    expect(resolveInitialTaskView({ stored: 'bogus' })).toBe('list');
  });
  it('legacy ?tab=board overrides the stored pref', () => {
    expect(resolveInitialTaskView({ stored: 'list', legacyBoard: true })).toBe('board');
  });
});

describe('toListRows', () => {
  it('orders by sortOrder and flags done by status', () => {
    const rows = toListRows([
      task({ id: 'b', sortOrder: 2, status: 'done' }),
      task({ id: 'a', sortOrder: 1, status: 'in_progress' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[0].done).toBe(false);
    expect(rows[1].done).toBe(true);
  });
  it('carries id/label/notes through', () => {
    const [row] = toListRows([task({ id: 'x', label: 'Ship it', notes: 'soon' })]);
    expect(row).toEqual({ id: 'x', label: 'Ship it', notes: 'soon', done: false });
  });
  it('does not mutate its input', () => {
    const input = [task({ id: 'b', sortOrder: 2 }), task({ id: 'a', sortOrder: 1 })];
    toListRows(input);
    expect(input.map((t) => t.id)).toEqual(['b', 'a']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/task-view.test.ts`
Expected: FAIL — `Cannot find module '../lib/task-view'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// lib/task-view.ts
// ABOUTME: Pure helpers for the unified Tasks tab (List ⇄ Board). Per-project localStorage key,
// ABOUTME: view parsing/resolution (legacy ?tab=board override + stored pref + default list), and
// ABOUTME: the BoardTask → list-row projection the live TaskListView renders. No React/DOM.

import type { BoardTask } from './board';

export const TASK_VIEWS = ['list', 'board'] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

export function taskViewStorageKey(slug: string): string {
  return `mc.taskView.${slug}`;
}

export function parseTaskView(raw: string | null | undefined): TaskView | null {
  return raw === 'list' || raw === 'board' ? raw : null;
}

export function resolveInitialTaskView(opts: { stored?: string | null; legacyBoard?: boolean }): TaskView {
  if (opts.legacyBoard) return 'board';
  return parseTaskView(opts.stored) ?? 'list';
}

export type TaskListRow = { id: string; label: string; notes: string | null; done: boolean };

export function toListRows(tasks: BoardTask[]): TaskListRow[] {
  return [...tasks]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t) => ({ id: t.id, label: t.label, notes: t.notes, done: t.status === 'done' }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/task-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/task-view.ts test/task-view.test.ts
git commit -m "feat: pure task-view helpers (storage key, resolution, list projection)"
```

---

## Task 3: Add `onChanged`/`onAdded` callbacks to TaskItem and AddTask

These optional callbacks let the live list refetch immediately after a mutation instead of waiting for the ~4s poll. Optional so existing call sites compile unchanged.

**Files:**
- Modify: `components/TaskItem.tsx`
- Modify: `components/AddTask.tsx`

- [ ] **Step 1: Update `TaskItem` props + mutation handlers**

In `components/TaskItem.tsx`, change the `Props` type and the two handlers. Replace lines 9-31 (the `type Props` block through the end of `onDelete`) with:

```tsx
type Props = {
  id: string;
  label: string;
  notes?: string | null;
  done: boolean;
  onChanged?: () => void;
};

export function TaskItem({ id, label, notes, done, onChanged }: Props) {
  const [optimisticDone, setOptimisticDone] = useState(done);
  const [, startTransition] = useTransition();

  function onToggle() {
    setOptimisticDone((d) => !d);
    startTransition(() => {
      void toggleTask(id).then(() => onChanged?.());
    });
  }

  function onDelete() {
    startTransition(() => {
      void deleteTask(id).then(() => onChanged?.());
    });
  }
```

(Leave the JSX return block below unchanged.)

- [ ] **Step 2: Update `AddTask` props + submit handler**

In `components/AddTask.tsx`, replace lines 8-19 (the function signature through the end of `submit`) with:

```tsx
export function AddTask({ projectId, onAdded }: { projectId: string; onAdded?: () => void }) {
  const [label, setLabel] = useState('');
  const [pending, startTransition] = useTransition();

  function submit() {
    const value = label.trim();
    if (!value) return;
    setLabel('');
    startTransition(() => {
      void addTask(projectId, value).then(() => onAdded?.());
    });
  }
```

(Leave the JSX return block below unchanged.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If `tsc` reports project-reference/composite errors unrelated to these files, fall back to `npm run build` to confirm the app compiles — see Task 9.)

- [ ] **Step 4: Commit**

```bash
git add components/TaskItem.tsx components/AddTask.tsx
git commit -m "feat: optional onChanged/onAdded callbacks on TaskItem/AddTask"
```

---

## Task 4: Live TaskListView

**Files:**
- Create: `components/TaskListView.tsx`

- [ ] **Step 1: Create the component**

```tsx
// components/TaskListView.tsx
'use client';

// ABOUTME: Live list view for the unified Tasks tab. Reads the same useBoard poll the Board uses
// ABOUTME: (so toggling between views is always consistent), renders TaskItem rows + AddTask, and
// ABOUTME: refetches immediately after a mutation via the hook's reload().

import { useBoard } from '@/lib/useBoard';
import { toListRows } from '@/lib/task-view';
import type { BoardData } from '@/lib/board';
import { TaskItem } from '@/components/TaskItem';
import { AddTask } from '@/components/AddTask';

export function TaskListView({
  slug,
  projectId,
  initial,
}: {
  slug: string;
  projectId: string;
  initial: BoardData;
}) {
  const { projects, reload } = useBoard({ projectSlug: slug, initial });
  const rows = toListRows(projects[0]?.tasks ?? []);

  return (
    <div className="detail-tasks">
      {rows.length > 0 ? (
        <ul className="tasklist">
          {rows.map((t) => (
            // key includes done so a remote status change remounts the row with fresh optimistic state
            <TaskItem key={`${t.id}:${t.done}`} id={t.id} label={t.label} notes={t.notes} done={t.done} onChanged={reload} />
          ))}
        </ul>
      ) : (
        <p className="detail-muted">No tasks yet.</p>
      )}
      <AddTask projectId={projectId} onAdded={reload} />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (`TaskListView` is imported by Task 5; on its own it's an unused export, which is fine.)

- [ ] **Step 3: Commit**

```bash
git add components/TaskListView.tsx
git commit -m "feat: live TaskListView fed by useBoard"
```

---

## Task 5: TasksPanel wrapper (toggle + persistence + legacy URL)

**Files:**
- Create: `components/TasksPanel.tsx`

- [ ] **Step 1: Create the component**

```tsx
// components/TasksPanel.tsx
'use client';

// ABOUTME: Unified Tasks tab: a List ⇄ Board pill toggle over one dataset. View choice is persisted
// ABOUTME: per-project in localStorage (mc.taskView.<slug>); a legacy ?tab=board deep-link forces the
// ABOUTME: Board view once (without overwriting the stored pref). Both views share the live useBoard data.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { BoardData } from '@/lib/board';
import {
  taskViewStorageKey,
  resolveInitialTaskView,
  type TaskView,
} from '@/lib/task-view';
import { TaskListView } from '@/components/TaskListView';
import { ProjectBoard } from '@/components/board/ProjectBoard';

export function TasksPanel({
  slug,
  projectId,
  initial,
  integrations,
}: {
  slug: string;
  projectId: string;
  initial: BoardData;
  integrations: { done: number; total: number };
}) {
  const sp = useSearchParams();
  const legacyBoard = sp.get('tab') === 'board';
  // Deterministic first paint (server + client agree on sp): default list, or board for a legacy link.
  const [view, setView] = useState<TaskView>(legacyBoard ? 'board' : 'list');
  const storageKey = taskViewStorageKey(slug);

  // After mount, apply the stored per-project pref — unless a legacy ?tab=board link is overriding it.
  useEffect(() => {
    if (legacyBoard) return;
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(storageKey) : null;
    // Reading persisted prefs after mount is the sanctioned setState-in-effect (avoids SSR mismatch).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setView(resolveInitialTaskView({ stored }));
  }, [storageKey, legacyBoard]);

  function changeView(v: TaskView) {
    setView(v);
    try {
      window.localStorage.setItem(storageKey, v);
    } catch {
      /* private mode / quota — non-fatal */
    }
  }

  return (
    <>
      <div className="view-toggle" role="group" aria-label="Task view">
        <button
          type="button"
          aria-pressed={view === 'list'}
          className={view === 'list' ? 'on' : ''}
          onClick={() => changeView('list')}
        >
          List
        </button>
        <button
          type="button"
          aria-pressed={view === 'board'}
          className={view === 'board' ? 'on' : ''}
          onClick={() => changeView('board')}
        >
          Board
        </button>
      </div>
      {view === 'list' ? (
        <TaskListView slug={slug} projectId={projectId} initial={initial} />
      ) : (
        <ProjectBoard slug={slug} initial={initial} integrations={integrations} />
      )}
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/TasksPanel.tsx
git commit -m "feat: TasksPanel — List/Board toggle with per-project persistence + legacy ?tab=board"
```

---

## Task 6: Wire the alias into TabbedPanels

**Files:**
- Modify: `components/TabbedPanels.tsx`

- [ ] **Step 1: Import the resolver and add the `aliases` prop**

In `components/TabbedPanels.tsx`, add this import after the existing `next/navigation` import (line 7):

```tsx
import { resolveActiveTab } from '@/lib/tabs';
```

- [ ] **Step 2: Use the resolver for the initial active key**

Replace the function signature and the `activeKey` initializer (lines 11-18) with:

```tsx
export function TabbedPanels({ tabs, aliases }: { tabs: Tab[]; aliases?: Record<string, string> }) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const fromUrl = sp.get('tab');
  const [activeKey, setActiveKey] = useState(() =>
    resolveActiveTab(fromUrl, tabs.map((t) => t.key), aliases),
  );
```

(Everything below — `tabRefs`, `select`, `onKeyDown`, the JSX — stays unchanged.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/TabbedPanels.tsx
git commit -m "feat: TabbedPanels supports tab aliases (legacy ?tab=board → tasks)"
```

---

## Task 7: Collapse the two tabs in the project detail page

**Files:**
- Modify: `app/p/[slug]/page.tsx`

- [ ] **Step 1: Swap imports**

In `app/p/[slug]/page.tsx`:
- Line 7 — drop `isTaskDone` from the `@/lib/ui` import (keep `statusTone, statusLabel`):
  ```tsx
  import { statusTone, statusLabel } from '@/lib/ui';
  ```
- Remove the now-unused component imports on lines 10-11:
  ```tsx
  // DELETE these two lines:
  // import { TaskItem } from '@/components/TaskItem';
  // import { AddTask } from '@/components/AddTask';
  ```
- Add the `TasksPanel` import next to the board import (after line 14):
  ```tsx
  import { TasksPanel } from '@/components/TasksPanel';
  ```
  (Keep `import { ProjectBoard } ...` — it is still used by `TasksPanel`'s tree, but is no longer referenced directly in this file. If `tsc`/eslint flags `ProjectBoard` as unused here, delete its import on line 14 too.)

- [ ] **Step 2: Remove the unused `customTasks` variable**

Delete line 73:

```tsx
// DELETE:
// const customTasks = project.tasks.filter((t) => !t.integrationType);
```

(`integrationTasks` on line 72 stays — it feeds `boardIntegrations`.)

- [ ] **Step 3: Delete the standalone `tasksPanel` JSX**

Delete the entire `tasksPanel` block (lines 115-128):

```tsx
// DELETE this whole block:
// const tasksPanel = ( ... <AddTask projectId={project.id} /> ... );
```

- [ ] **Step 4: Replace the `boardPanel` block with a unified TasksPanel**

Replace lines 132-139 (the `boardInitial` / `boardIntegrations` / `boardPanel` block) with:

```tsx
  const boardInitial = { projects: [toBoardProject(project, false)], runs: [] };
  const boardIntegrations = {
    done: integrationTasks.filter((t) => t.integrationStatus === 'done').length,
    total: integrationTasks.length,
  };
  const tasksPanel = (
    <TasksPanel
      slug={project.slug}
      projectId={project.id}
      initial={boardInitial}
      integrations={boardIntegrations}
    />
  );
```

- [ ] **Step 5: Update the tab list**

In the `<TabbedPanels tabs={[...]}>` array (lines 178-198), replace the two entries:

```tsx
              { key: 'tasks', label: 'Tasks', content: tasksPanel },
              { key: 'board', label: 'Board', content: boardPanel },
```

with the single entry:

```tsx
              { key: 'tasks', label: 'Tasks', content: tasksPanel },
```

Then add the `aliases` prop to the component so legacy `?tab=board` links land on the Tasks tab. Change the opening tag from `<TabbedPanels` to:

```tsx
          <TabbedPanels
            aliases={{ board: 'tasks' }}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors, no "unused variable" complaints (`boardPanel` and `customTasks` are gone; `isTaskDone`/`TaskItem`/`AddTask` imports removed).

- [ ] **Step 7: Commit**

```bash
git add app/p/[slug]/page.tsx
git commit -m "feat: collapse Tasks + Board into one Tasks tab (TasksPanel)"
```

---

## Task 8: Style the view toggle

**Files:**
- Modify: `app/globals.css`

- [ ] **Step 1: Add the `.view-toggle` block**

Append this immediately after the `.tab.active .tab-count { ... }` rule (after line 433 in `app/globals.css`):

```css
/* ===================== TASK VIEW TOGGLE ===================== */
.view-toggle {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  margin-bottom: var(--space-md);
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.view-toggle button {
  appearance: none;
  border: none;
  background: transparent;
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ink-mute);
  min-height: 32px;
  padding: 5px 14px;
  border-radius: calc(var(--radius-sm) - 2px);
  transition: color 0.15s ease, background 0.15s ease;
}
.view-toggle button:hover { color: var(--ink-dim); }
.view-toggle button.on { color: var(--accent-ink); background: var(--accent-soft); }
```

- [ ] **Step 2: Commit**

```bash
git add app/globals.css
git commit -m "style: segmented pill control for the Tasks view toggle"
```

---

## Task 9: Verification gates

**Files:** none (verification only)

- [ ] **Step 1: Run the new unit tests**

Run: `npx vitest run test/tabs.test.ts test/task-view.test.ts`
Expected: PASS (all tests in both files). These are DB-free; they run without `.env.local`.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors. (This repo's `lint` script is `eslint`.)

- [ ] **Step 3: Typecheck / build**

Run: `npx tsc --noEmit`
Expected: no errors.
If `tsc` emits project-reference/composite errors that are unrelated to the changed files (the `cli/` workspace can do this), instead run `npm run build` and confirm the Next build compiles the app without type errors.

- [ ] **Step 4: Manual browser verification**

Start the dev server (`npm run dev`, port 3030) and open a project detail page (`/p/<slug>`). Verify:
  1. The tab bar shows a single **Tasks** tab (no separate **Board** tab).
  2. Under the tab, the **List | Board** pill toggle appears; **List** is selected by default on first visit.
  3. List view: add a task, check it off (strikethrough), delete it — each reflects within ~1s (immediate `reload`, not a 4s wait).
  4. Switch to **Board**, drag a task to **done**, switch back to **List** — the task shows as done immediately (shared live data).
  5. Reload the page — the last-selected view is remembered for **this** project; open a *different* project and confirm it independently defaults to List (per-project persistence).
  6. Visit `/p/<slug>?tab=board` directly — the Tasks tab is active and the **Board** view is shown.

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore: verification fixups for unified Tasks tab"
```

---

## Self-Review Notes (author)

- **Spec coverage:** single Tasks tab (T7) · toggle placement/style option B (T5 + T8) · default List + per-project persistence `mc.taskView.<slug>` (T2, T5) · legacy `?tab=board` → Tasks/Board (T1, T6, T7) · single live source via `useBoard` (T4) · roles unchanged — Board untouched, List gains no drag/status/claim (T4 reuses `TaskItem`/`AddTask` only) · empty state "No tasks yet." (T4) · prompt refresh after mutations (T3 callbacks → `reload`) · testing of persistence/legacy/projection (T1, T2). All spec sections map to a task.
- **Out-of-scope respected:** no add/delete on Board, no list drag/status/claim, no new URL param beyond the legacy alias, no change to claim-locking.
- **Type consistency:** `TaskView` ('list'|'board'), `taskViewStorageKey`, `resolveInitialTaskView({stored, legacyBoard})`, `toListRows(BoardTask[]) → TaskListRow[]`, `resolveActiveTab(fromUrl, keys, aliases)`, `onChanged?`/`onAdded?` callbacks, and `useBoard().reload` are used identically across tasks.
- **No DOM tests:** consistent with repo convention (node-env vitest); React wiring is covered by typecheck/lint + the manual checklist in T9.

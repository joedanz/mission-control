# Legacy `mc integration` Removal (slice 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the unrelated legacy "integration" status-tracker (`mc integration` CLI, `tasks.kind`/`integration_type`/`integration_status` columns + their enums, `upsertIntegration`, `integrationStatusOf`, ProjectRow chips) so "integration" stops being an overloaded word — leaving only the MCP surface and the (unrelated, KEPT) workflow integration node.

**Architecture:** The status-tracker is dashboard-badge-only — it calls no APIs and feeds no agents. Every `tasks.kind` consumer exists solely to *exclude* integration tasks from the board/claim queue; once integration tasks are gone, all tasks are custom and `kind` is dead, so we **drop** the column (spec-sanctioned). Order of work: remove all consumers first (CLI, UI, lib functions) while the columns still exist (keeps `tsc` green), then drop the schema columns + the now-orphaned `kind` filters + recreate two affected indexes in a single migration last.

**Tech Stack:** Drizzle/Neon (migration 0020 — `db:generate` then hand-edit SQL to add the row DELETE + safe DDL order), `mc` CLI (Commander + SPEC/ENUMS catalogs guarded by `test/spec-sync.test.ts`), Vitest (real Neon), React server component (ProjectRow).

---

## CRITICAL — do NOT touch (naming carve-out)

The **workflow integration node** is a *different concept* that legitimately keeps the name "integration":
- `IntegrationNodeData` (`lib/db/schema.ts:489`), `executeIntegrationNode` + `kind: 'integration'` **step-output marker** (`daemon/workflow-runner.ts:377`), `test/workflow-refs.test.ts` step-output shapes.
- Anything MCP: `mcp_connections`, `mc mcp`, `composio_toolkits`, `lib/composio-*`.

Leave ALL of the above untouched. This slice deletes only the **task** status-tracker.

## Decision: drop `tasks.kind` (not pin)

Every `kind` reader filters to/from `'custom'` to keep integration tasks off the board + claim queue. With integration tasks deleted, all tasks are custom → the column and its filters are dead. We drop it. Indexes that reference the dropped columns are recreated without those predicates.

## File structure

- `cli/index.ts` — remove the `integration` command group, its 2 SPEC entries, `ENUMS.integrationType`/`integrationStatus`, the schema import of `INTEGRATION_TYPES`/`INTEGRATION_STATUSES`, and `mc task list --kind` (option + filter).
- `lib/ui.ts` — remove `integrationStatusOf`.
- `components/ProjectRow.tsx` — remove `IntgCell` + its two calls + the import.
- `lib/mutations.ts` — remove `upsertIntegration`; drop `kind: 'custom'` from `addTask` + `importTasks`; (in the schema task) remove the `kind` filters in `claimTask`/`moveTask` + the claim error-reason branch.
- `lib/queries.ts` — (schema task) remove the `kind` filter in `getNextClaimableTask`.
- **Profile `taskKinds` routing dimension** (its own task — routes on the now-dead task kind): `lib/profiles.ts` (`ProfileMatchRules.taskKinds`, the `taskKinds` check in `profileMatchesContext`, `MatchContext.taskKind`), `lib/profile-form.ts` (`buildMatchRules` + `formFromProfile` taskKinds), `components/profiles/ProfilesView.tsx` (the `kinds: …` display), `cli/index.ts` (`--match-kind` option, `taskKind` in `buildMatchRules`, `mc profile resolve --kind` + its `ctx.taskKind = t.kind` read, `--match-kind` in the two `profile add/update` SPEC entries), `test/profile-form.test.ts` + `test/agent-profiles.test.ts`.
- `cli/index.ts` `mc task move` — (schema task) remove the `current.kind !== 'custom'` guard + the `t.kind === 'custom'` sibling filter (lines ~704-711).
- `lib/db/schema.ts` — (final task) remove `INTEGRATION_TYPES`/`INTEGRATION_STATUSES` + their types, the `kind`/`integration_type`/`integration_status` columns, the `tasks_project_integration_uq` index; retrim `tasks_project_label_uq` (drop the `WHERE integration_type IS NULL`) and `tasks_claimable_idx` (drop the `and kind = 'custom'`).
- `migrations/0020_*.sql` (new) — DELETE integration rows, drop indexes, drop columns, recreate the 2 indexes.
- Tests: `test/spec-sync.test.ts` (drop the 2 integration ENUM assertions + imports), `test/claim-lifecycle.test.ts` (remove the integration-not-claimable case), `test/board.test.ts` (remove the non-custom move case).
- Docs: `README.md`, `cli/README.md`, `AGENTS.md`.

## Conventions (match exactly)

- **Lint:** `npx eslint <files>` (NOT `npm run lint`). **Typecheck:** `npx tsc --noEmit` (4 pre-existing `WorkflowNode` errors in `test/workflow-runner.test.ts` are expected — ignore only those).
- **Tests:** `npx vitest run <file>` — these hit **real Neon** (the active `.env.local` pair). Migrations apply to the same DB.
- **Migration:** edit `schema.ts` → `npm run db:generate` → hand-edit the generated `.sql` → `npm run db:migrate` → `npm run db:generate` again must report **no changes**.
- Commit after each task.

---

### Task 1: Remove the `mc integration` CLI + enums + `--kind`

**Files:**
- Modify: `cli/index.ts` (lines ~16-17 imports, ~324-325 ENUMS, ~343 `--kind` option, ~353-354 SPEC, ~631 `--kind` filter, ~850-885 command group)
- Modify: `test/spec-sync.test.ts` (remove the 2 integration ENUM assertions + the 2 now-unused schema imports)

- [ ] **Step 1: Update `test/spec-sync.test.ts` first (red → green guard).** Remove `INTEGRATION_TYPES,` and `INTEGRATION_STATUSES,` from the `lib/db/schema` import list, and delete these two lines from the "ENUMS catalog matches its lib/db/schema source-of-truth" test:
```ts
    expect(ENUMS.integrationType).toEqual([...INTEGRATION_TYPES]);
    expect(ENUMS.integrationStatus).toEqual([...INTEGRATION_STATUSES]);
```

- [ ] **Step 2: Edit `cli/index.ts`:**
  - Remove `INTEGRATION_TYPES,` and `INTEGRATION_STATUSES,` from the `@/lib/db/schema` (or `../lib/db/schema`) import.
  - In the `ENUMS` object, remove `integrationType: INTEGRATION_TYPES,` and `integrationStatus: INTEGRATION_STATUSES,`.
  - In `SPEC`, remove the two entries `{ name: 'integration set', ... }` and `{ name: 'integration list', ... }`.
  - Remove the `mc task list` `--kind` option line (`.option('--kind ...', 'custom | integration')`) and, in its action, the filter `if (opts.kind) items = items.filter((t) => t.kind === opts.kind);`.
  - Remove the entire `integration` command group block (`const integration = program.command('integration')...` through the end of `integration list`'s `.action(...)`).
  - Remove `assertEnum` import ONLY if it becomes unused (grep first — it's likely used elsewhere; if so, keep it).

- [ ] **Step 3: Verify.**
  - `npx vitest run test/spec-sync.test.ts` → PASS (registered==SPEC after removing both the commands and the SPEC entries; ENUMS matches after removing the two assertions).
  - `npx tsc --noEmit` → only the 4 WorkflowNode errors.
  - `npx eslint cli/index.ts test/spec-sync.test.ts` → clean.
  - Smoke (needs `AGENT_DATABASE_URL` from `.env.local`): `mc enums --json` no longer lists `integrationType`/`integrationStatus`; `mc --help` shows no `integration` command; `mc task list <slug> --help` shows no `--kind`.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(mcp): remove mc integration CLI + enums + task --kind (slice 5)"`

---

### Task 2: Remove `integrationStatusOf` + ProjectRow chips

**Files:**
- Modify: `lib/ui.ts` (remove `integrationStatusOf`, ~lines 146-154)
- Modify: `components/ProjectRow.tsx` (remove `IntgCell` ~22-55, its two render calls ~92-93, and the `integrationStatusOf` import ~10)

- [ ] **Step 1: Remove `integrationStatusOf`** from `lib/ui.ts` (the whole function + its doc comment). Grep `integrationStatusOf` across the repo afterward — only `ProjectRow.tsx` should have referenced it.

- [ ] **Step 2: Edit `components/ProjectRow.tsx`:**
  - Remove the `integrationStatusOf` import.
  - Remove the `IntgCell` component definition.
  - Remove the two `<IntgCell lane="sen" ... />` / `zoho_email` render calls (and any now-empty wrapper cell/grid column around them — inspect the surrounding JSX; if removing the two cells leaves an empty container or a dangling grid column, remove that too, and check `app/globals.css` for a now-unused `.col-intg` / `IntgCell` class — leave CSS untouched unless clearly dead, note it for the final task).

- [ ] **Step 3: Verify.**
  - `npx tsc --noEmit` → only the 4 WorkflowNode errors.
  - `npx eslint lib/ui.ts components/ProjectRow.tsx` → clean.
  - `grep -rn "integrationStatusOf\|IntgCell" app components lib` → zero matches.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(mcp): remove integration status chips from the dashboard (slice 5)"`

---

### Task 3: Remove `upsertIntegration` + `kind` from inserts + its tests

**Files:**
- Modify: `lib/mutations.ts` (remove `upsertIntegration` ~525-563; remove `kind: 'custom',` from `addTask` ~243 and `importTasks` ~265)
- Modify: `test/claim-lifecycle.test.ts` (remove the "an integration task is not claimable" case, ~94-98)

Note: the `tasks.kind` column still exists (NOT NULL DEFAULT 'custom'), so inserts that omit `kind` still fill it. The `kind` *filters* in claimTask/moveTask/getNextClaimableTask stay until Task 4 (they keep protecting any not-yet-deleted integration rows).

- [ ] **Step 1: Remove the integration test case** from `test/claim-lifecycle.test.ts` (the `it(...)` that calls `upsertIntegration(projectId, 'sentry', 'needed')` then expects `claimTask` to reject). Remove the `upsertIntegration` import if it becomes unused.

- [ ] **Step 2: Edit `lib/mutations.ts`:**
  - Delete the entire `upsertIntegration` function (and its doc comment).
  - Remove `kind: 'custom',` from the `addTask` insert `.values({...})` and from the `importTasks` insert `.values({...})`.
  - Remove the `IntegrationType`/`IntegrationStatus` imports from `@/lib/db/schema` if `upsertIntegration` was their only user (grep within the file first).

- [ ] **Step 3: Verify.**
  - `npx vitest run test/claim-lifecycle.test.ts test/board.test.ts` → PASS (board's integration case is removed in Task 4; it still passes here because the column + filters still exist).
  - `npx tsc --noEmit` → only the 4 WorkflowNode errors.
  - `npx eslint lib/mutations.ts test/claim-lifecycle.test.ts` → clean.
  - `grep -rn "upsertIntegration" app components lib cli test` → zero matches.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(mcp): remove upsertIntegration + kind from task inserts (slice 5)"`

---

### Task 4: Remove the `taskKinds` profile-routing dimension

Dropping `tasks.kind` makes the `--match-kind` routing dimension dead; left in place it would silently misroute any profile with a `taskKinds` rule (`ctx.taskKind` becomes permanently undefined). Remove it now (before the column drop — `mc profile resolve` reads a task's `kind`, so this must precede Task 5).

**Files:**
- Modify: `lib/profiles.ts`, `lib/profile-form.ts`, `components/profiles/ProfilesView.tsx`, `cli/index.ts`
- Modify: `test/profile-form.test.ts`, `test/agent-profiles.test.ts`

- [ ] **Step 1: Locate the `ProfileMatchRules` type definition** (`lib/profiles.ts:12` imports `type ProfileMatchRules` — grep for `taskKinds` to find where the type is declared, likely `lib/profiles.ts` or a types module). Remove the `taskKinds?: ...` field from `ProfileMatchRules`, and remove `taskKind?: ...` from the `MatchContext` type.

- [ ] **Step 2: `lib/profiles.ts` `profileMatchesContext`** — remove `taskKinds` from the destructure (`const { projectSlugs, projectCategories, taskKinds, labelPattern } = rules;`) and delete the block:
```ts
  if (taskKinds?.length) {
    if (!ctx.taskKind || !taskKinds.includes(ctx.taskKind)) return false;
  }
```

- [ ] **Step 3: `lib/profile-form.ts`** — remove `if (s.matchTaskKinds.length) rules.taskKinds = s.matchTaskKinds;` (buildMatchRules) and `matchTaskKinds: m.taskKinds ?? [],` (formFromProfile) + the `matchTaskKinds` field from the form-state type/initial state (grep `matchTaskKinds`).

- [ ] **Step 4: `components/profiles/ProfilesView.tsx`** — remove `if (r.taskKinds?.length) parts.push(\`kinds: ${r.taskKinds.join(', ')}\`);`.

- [ ] **Step 5: `cli/index.ts`** — remove: the `--match-kind <csv>` option (`.option('--match-kind <csv>', 'custom | integration')`), `if (opts.matchKind !== undefined) rules.taskKinds = csv(opts.matchKind);`, the `--match-kind` token from BOTH the `profile add` and `profile update` SPEC entries' `options` arrays, and in `mc profile resolve` remove `ctx.taskKind = t.kind;` and `if (opts.kind !== undefined) ctx.taskKind = String(opts.kind);` plus the `--kind` option on the resolve command + its SPEC entry's `--kind`/`[--kind ...]`.

- [ ] **Step 6: Tests** — update `test/profile-form.test.ts` + `test/agent-profiles.test.ts`: remove any `taskKinds`/`matchTaskKinds`/`--match-kind`/`taskKind` assertions or fixtures. Run them green.

- [ ] **Step 7: Verify.**
  - `npx tsc --noEmit` → only the 4 WorkflowNode errors. (Note: `cli/index.ts` `mc task move`/`mc task list` still read `t.kind` — those are removed in Task 5; the column still exists so they compile here.)
  - `npx eslint lib/profiles.ts lib/profile-form.ts components/profiles/ProfilesView.tsx cli/index.ts test/profile-form.test.ts test/agent-profiles.test.ts` → clean.
  - `npx vitest run test/profile-form.test.ts test/agent-profiles.test.ts test/spec-sync.test.ts` → PASS.
  - `grep -rn "taskKinds\|matchTaskKinds\|match-kind\|matchKind\|ctx.taskKind\|taskKind" lib cli components app` → zero matches.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(mcp): remove the taskKinds profile-routing dimension (slice 5)"`

---

### Task 5: Drop the schema columns + enums + retrim indexes + the kind filters (migration 0020)

**Files:**
**SCOPE CORRECTION (recon gap):** the initial recon classified by symbol name and missed several readers of `tasks.kind`/`integration_type`/`integration_status`. The full reader set (all legacy-tracker, all must go) is: `lib/mutations.ts` (`claimTask` WHERE+reason, `moveTask` guard, `toggleTask` integration branch + payload, `terminalizeClaimsForRun` kind filter, `importTasks` onConflict `where`), `lib/queries.ts` (`getNextClaimableTask`), `cli/index.ts` (`task move` guard+filter, `task list` printer `(${t.integrationType})` suffix), `lib/ui.ts` (`isTaskDone`/`taskState` integration branch), and the **board "Integrations N/M" badge**: `lib/board.ts` (`BoardProject.integrations` + the custom/integration split), `components/TasksPanel.tsx` + `components/board/ProjectBoard.tsx` (prop + render `board-intg`), `components/board/OverallBoard.tsx` (render `board-intg`), `app/p/[slug]/page.tsx` (`integrationTasks` + `boardIntegrations`). Task 5 is split: **5a** removes every reader (columns stay → tsc/tests green), **5b** drops the columns + migration.

This is **Task 5a** below; the column-drop migration is **Task 5b**.

**Files (5a):**
- Modify: `lib/mutations.ts` (`claimTask`, `moveTask`, `toggleTask`, `terminalizeClaimsForRun`), `lib/queries.ts`, `cli/index.ts` (`task move`, `task list` printer), `lib/ui.ts`, `lib/board.ts`, `components/TasksPanel.tsx`, `components/board/ProjectBoard.tsx`, `components/board/OverallBoard.tsx`, `app/p/[slug]/page.tsx`, `test/board.test.ts`
- NOTE: keep `importTasks`'s `onConflictDoNothing({ ..., where: sql\`integration_type is null\` })` UNTOUCHED in 5a — its `where` is the arbiter predicate for the partial `tasks_project_label_uq` index; it's removed in 5b when that index becomes non-partial. The `integration_type` column still exists in 5a, so it compiles.

- [ ] **Step 1: Remove the `kind` claim/move filters:**
  - `lib/mutations.ts` `claimTask`: remove `eq(tasks.kind, 'custom')` from the WHERE `and(...)`, and remove the branch `if (existing.kind !== 'custom') reason = ...;` (re-chain the remaining `if (heldNow) … else if (status !== 'todo') … else …`).
  - `lib/mutations.ts` `moveTask`: remove the guard `if (current.kind !== 'custom') return null;`.
  - `lib/mutations.ts` `terminalizeClaimsForRun`: change `.where(and(eq(tasks.claimedByRunId, runId), eq(tasks.kind, 'custom')))` → `.where(eq(tasks.claimedByRunId, runId))`.
  - `lib/queries.ts` `getNextClaimableTask`: remove `eq(tasks.kind, 'custom')` from its WHERE.
  - `cli/index.ts` `mc task move`: remove the guard `if (current.kind !== 'custom') { throw new ValidationError('id', …); }` and the `t.kind === 'custom' &&` clause from the sibling-task filter (→ `.filter((t) => t.status === destStatus && t.id !== id)`).

- [ ] **Step 2: Remove the `toggleTask` integration branch** (`lib/mutations.ts`): the function currently branches `task.integrationType ? <flip integrationStatus> : <flip status>`. Replace with the status-only flip (the `else` branch) directly on `taskId` (`.returning()` returns `[]` → return null if no row), dropping the `getTaskById` pre-read + the integration comment. Change the event payload `payload: { status: row.status, integrationStatus: row.integrationStatus }` → `payload: { status: row.status }`. Verify `getTaskById`/`eq` imports are still used elsewhere before removing.

- [ ] **Step 3: Simplify `lib/ui.ts`** — `isTaskDone(t)` → `return t.status === 'done';`; `taskState(t)` → `return t.status;` (drop the `t.integrationType ? … :` ternary in both).

- [ ] **Step 4: Remove the board integration badge:**
  - `lib/board.ts`: remove the `integrations: { done: number; total: number }` field from the `BoardProject` type; in `toBoardProject`, remove `const integration = p.tasks.filter((t) => t.integrationType);`, change `const custom = p.tasks.filter((t) => !t.integrationType);` → `const custom = p.tasks;`, and remove the `integrations: { done: …, total: … },` entry from the returned object.
  - `components/TasksPanel.tsx`: remove the `integrations` prop (the destructure `integrations,`, the type `integrations: { done: number; total: number };`, and the `integrations={integrations}` pass-through to `<ProjectBoard>`).
  - `components/board/ProjectBoard.tsx`: remove the `integrations` prop (destructure + type) and the `<a className="board-intg" …>Integrations {integrations.done}/{integrations.total}</a>` element (~142-143).
  - `components/board/OverallBoard.tsx`: remove the `<a className="board-intg" …>Integrations {project.integrations.done}/{project.integrations.total}</a>` element (~50-51).
  - `app/p/[slug]/page.tsx`: remove `const integrationTasks = …` (~70), the `const boardIntegrations = {…}` block (~116), and the `integrations={boardIntegrations}` prop on `<TasksPanel>`.
  - Note the now-unused `.board-intg` CSS class in `app/globals.css` for the Task 6 cleanup (leave CSS here).

- [ ] **Step 5: `cli/index.ts` `task list` printer** — remove the `${t.integrationType ? ` (${t.integrationType})` : ''}` suffix from the `console.log` task line.

- [ ] **Step 6: `test/board.test.ts`** — remove the "moveTask returns null for a non-custom task" `it(...)` (inserts `kind: 'integration', integrationType, integrationStatus`).

- [ ] **Step 7: Verify 5a.**
  - `npx tsc --noEmit` → only the 4 WorkflowNode errors (columns still exist, so no `kind`/`integration` errors — all readers are gone).
  - `npx eslint` on every changed file → clean.
  - `npx vitest run test/board.test.ts test/claim-lifecycle.test.ts test/spec-sync.test.ts` → PASS.
  - `npm run build` → compiles (board + project page render without the badge).
  - `grep -rn "integrationType\|integrationStatus\|tasks.kind\|\.kind === 'custom'\|\.kind !== 'custom'\|board-intg" lib app cli components` → zero matches (the only surviving `kind`s are unrelated: daemon workflow step marker, `kind:'agent'` actors, React `state.kind` unions).

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(mcp): remove all legacy integration-task readers + board badge (slice 5)"`

---

### Task 5b: Drop the schema columns + enums + retrim indexes (migration 0020)

**Files:**
- Modify: `lib/db/schema.ts`, `lib/mutations.ts` (`importTasks` onConflict `where`)
- Create: `migrations/0020_*.sql` (+ snapshot + journal via `db:generate`)

- [ ] **Step 0: `lib/mutations.ts` `importTasks`** — remove the `where: sql\`integration_type is null\`` from `onConflictDoNothing` (→ `.onConflictDoNothing({ target: [tasks.projectId, tasks.label] })`), since the `tasks_project_label_uq` index becomes non-partial in this migration.

- [ ] **Step 1: Edit `lib/db/schema.ts`:**
  - Remove `export const INTEGRATION_TYPES = [...]` and `export const INTEGRATION_STATUSES = [...]` and their `export type IntegrationType` / `IntegrationStatus`.
  - In the `tasks` table: remove the `kind`, `integrationType`, and `integrationStatus` column definitions. Update the column comments accordingly.
  - In the `tasks` index block: remove the `tasks_project_integration_uq` index entirely; change `tasks_project_label_uq` to drop `.where(sql\`integration_type IS NULL\`)` (plain `uniqueIndex('tasks_project_label_uq').on(t.projectId, t.label)`); change `tasks_claimable_idx`'s predicate from `` sql`status = 'todo' and kind = 'custom'` `` to `` sql`status = 'todo'` ``.

- [ ] **Step 2: Generate the migration** — `npm run db:generate`. It creates `migrations/0020_*.sql` + updates the snapshot + journal.

- [ ] **Step 3: Hand-edit the generated `0020_*.sql`** so its body is EXACTLY this (preserve the drizzle-assigned filename; the DELETE is a data step drizzle won't emit, and `IF EXISTS` + index-drops-before-column-drops avoids dependency-order errors):
```sql
DELETE FROM "tasks" WHERE "kind" = 'integration';--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_project_integration_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_project_label_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "tasks_claimable_idx";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "integration_type";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "integration_status";--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_project_label_uq" ON "tasks" USING btree ("project_id","label");--> statement-breakpoint
CREATE INDEX "tasks_claimable_idx" ON "tasks" USING btree ("sort_order","created_at") WHERE status = 'todo';
```
  (Match drizzle's exact `CREATE INDEX` syntax/quoting from what it generated for the surviving indexes — copy its `USING btree (...)` form. The hand-edits — the leading DELETE, `IF EXISTS`, and statement order — don't affect the snapshot.)

- [ ] **Step 4: Apply + verify the migration:**
  - `npm run db:migrate` → applies cleanly.
  - `npm run db:generate` → must report **No schema changes** (snapshot matches schema.ts).
  - Confirm columns gone + rows deleted: `mc task list <slug> --json` returns tasks with no `kind`/`integrationType` fields and no "… setup" integration rows remain.

- [ ] **Step 5: Verify code.**
  - `npx tsc --noEmit` → ONLY the 4 WorkflowNode errors, zero `kind`/`integration` errors.
  - `npx eslint lib/db/schema.ts lib/mutations.ts` → clean.
  - `npx vitest run test/board.test.ts test/claim-lifecycle.test.ts test/spec-sync.test.ts` → PASS.
  - `grep -rn "integration_type\|integration_status\|INTEGRATION_TYPES\|INTEGRATION_STATUSES\|tasks.kind" lib app cli components` → zero matches (the only surviving `kind:'integration'` is the daemon workflow step marker, NOT touched).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(mcp)!: drop tasks.kind + integration columns, retrim indexes (migration 0020, slice 5)"`

---

### Task 6: Docs, full verification, finish

**Files:**
- Modify: `README.md`, `cli/README.md`, `AGENTS.md`

- [ ] **Step 1: Docs.** Remove every reference to the legacy tracker:
  - `README.md`: the `integration set` example.
  - `cli/README.md`: the `mc integration set|list` command docs; the `--kind custom|integration` on `mc task list`; `integrationStatus` in the camelCase data-key list.
  - `AGENTS.md` + `cli/README.md`: the `mc integration set|list` lines; `[--kind custom|integration]` on `mc task list`; the `--match-kind <csv>` token in `mc profile add`/`mc profile update`; the `[--kind custom|integration]` on `mc profile resolve`; and `integrationType`/`integrationStatus` from the `mc enums` description if listed. (All these CLI surfaces were removed in Tasks 1 + 4 — the docs must match.)

- [ ] **Step 2: Full suite** — `npx vitest run`. Slice-touched files must be green. (Known: the real-Neon suite can throw transient `ECONNRESET`/`fetch failed` under load — re-run any failed file in isolation to confirm it's infra, not a regression.)

- [ ] **Step 3: Build** — `npm run build` → compiles (validates ProjectRow + the page still render after chip removal).

- [ ] **Step 4: Final code review** — dispatch `feature-dev:code-reviewer` over `git diff main...HEAD`. Focus: no remaining `tasks.kind` reader; the migration's row-DELETE + index recreation are correct + ordered; the claim/move/queue logic is still correct without the kind filter; the workflow integration node is untouched; `mc spec`/`enums` consistent (spec-sync green).

- [ ] **Step 5: Update memory** — mark slice 5 SHIPPED in `project_mcp_unification.md` + `MEMORY.md` (PR # + squash sha after merge); note the unification effort is now COMPLETE.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "docs(mcp): drop legacy integration references (slice 5)"`

Then finish via superpowers:finishing-a-development-branch (PR + squash-merge per the slice workflow).

---

## Self-review (done at authoring)

- **Carve-out safety:** the workflow integration node (`IntegrationNodeData`, `kind:'integration'` step marker) is explicitly excluded; Task 4 Step 7 greps to confirm only the daemon's step marker remains. ✓
- **Order keeps tsc green:** consumers removed (Tasks 1-3) while columns exist; columns + orphaned filters dropped together (Task 4). ✓
- **`spec-sync.test.ts` coupling:** the 2 ENUM assertions + imports are removed in Task 1 alongside the ENUMS/command removal (single coherent change). ✓
- **Index integrity:** both partial indexes that reference dropped columns are recreated without those predicates; migration drops indexes before columns + uses `IF EXISTS` to survive Postgres's auto-cascade. ✓
- **Data safety:** existing `kind='integration'` rows are DELETEd in the migration before the column drop, so they can't resurface as claimable custom tasks. ✓
- **Routing dimension:** the `taskKinds` profile-match dimension (`--match-kind`) routed on the dropped column → would silently misroute; removed wholesale in Task 4 (before the column drop, since `mc profile resolve` reads `t.kind`). ✓
- **All `tasks.kind` readers enumerated:** lib (claim/move/queue), CLI (`task list --kind`, `task move`, `integration list`, `profile resolve`), profile routing (`taskKinds`) — each assigned to a task; Task 5 Step 7 greps to confirm zero `tasks.kind` references remain (the daemon workflow-node `kind:'integration'` step marker is the only legitimate survivor). ✓

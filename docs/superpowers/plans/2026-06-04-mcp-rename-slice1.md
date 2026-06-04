# MCP Rename (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the `composio_connections` table → `mcp_connections` (adding a `source` column, default `'composio'`) and the `mc composio` CLI namespace → `mc mcp`, with byte-identical runtime behavior — the foundational slice that lets later slices add the full Composio catalog and direct remote MCP servers.

**Architecture:** Pure rename. The DB table and its Drizzle symbol/type are renamed and gain an additive `source` column nothing reads yet. The CLI command group `composio` becomes `mcp` and its awkward `mcp-config` subcommand becomes `config`. The one daemon call that shells out to the CLI is updated to match. The `composio_toolkits` cache table, the `composio-*.ts` lib **file names**, the Composio REST client, the MCP server-key prefix (`composio-`), and the `/api/projects/[slug]/composio` route are intentionally left unchanged this slice (genuinely Composio-specific, or deferred to reduce churn).

**Tech Stack:** TypeScript, Drizzle ORM + drizzle-kit (Postgres/Neon), Commander-style CLI (`cli/index.ts`), Vitest (tests hit the real Neon dev branch).

**Spec:** `docs/superpowers/specs/2026-06-04-mcp-connections-design.md`

---

## File Structure

| File | Responsibility | This slice |
|---|---|---|
| `lib/db/schema.ts` | Drizzle table/type defs | Rename `composioConnections`→`mcpConnections` (table `mcp_connections`), `ComposioConnection`→`McpConnection`, indexes; add `source` column |
| `migrations/0017_*.sql` + `migrations/meta/*` | Generated migration + snapshot | New migration: rename table + indexes, add column |
| `lib/composio-store.ts` | DB CRUD for connections/toolkits | Update import + usages of the renamed symbol/type (file name unchanged) |
| `cli/index.ts` | CLI command tree + `mc spec` | Rename command group + `mcp-config`→`config`; update SPEC entries + help text |
| `daemon/runner.ts` | Spawn-time MCP auto-feed | Update the `mc(['composio','mcp-config',…])` call → `mc(['mcp','config',…])` |
| `AGENTS.md` | Agent-facing CLI reference | Update the `mc composio …` block → `mc mcp …` |

Intentionally **not** touched: `lib/composio-api.ts`, `lib/composio-mcp.ts`, `lib/composio-catalog.ts`, `lib/composio-connections.ts`, `lib/composio-view.ts`, `app/api/projects/[slug]/composio/route.ts`, `lib/workflows.ts`, `daemon/workflow-runner.ts` (the integration node) — none reference the renamed DB symbol directly, and their file names are deferred.

---

## Task 1: Rename the schema + add `source`, generate the migration

**Files:**
- Modify: `lib/db/schema.ts:361-397`
- Create: `migrations/0017_<drizzle-name>.sql` (+ `migrations/meta/_journal.json`, `migrations/meta/0017_snapshot.json` — generated)

- [ ] **Step 1: Edit the schema**

In `lib/db/schema.ts`, replace the `composioConnections` table block (currently lines 364–394) and its exported type (line 397). Keep `composioToolkits` (350–357) and `ComposioToolkit` (396) and `ConnectionStatus` (361) exactly as they are.

```ts
export const mcpConnections = pgTable(
  'mcp_connections',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Source of this MCP server: 'composio' (a brokered toolkit, the only source today) or, in a
    // later slice, 'remote' (a directly-supplied remote-http MCP server). Default keeps every
    // existing row a composio connection — byte-identical behavior.
    source: text('source').notNull().default('composio'),
    // References a COMPOSIO_CATALOG key (the code catalog is the authority for valid toolkits) —
    // intentionally NOT a FK to composio_toolkits.slug: that table is a lazily-populated resource
    // CACHE, and a connection is "for the linear toolkit" independent of whether the cache row
    // exists yet. Orchestration validates the slug via getCatalogEntry + ensures the cache row
    // (ensure-before-connect) before any connection is written.
    toolkitSlug: text('toolkit_slug').notNull(),
    userId: text('user_id').notNull(), // mc-proj-<projectId> — the Composio user_id
    connectedAccountId: text('connected_account_id'), // Composio ca_… (set once link initiated)
    status: text('status').$type<ConnectionStatus>().notNull().default('initializing'),
    linkUrl: text('link_url'), // transient hosted link for an in-flight connect
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // INTENTIONAL single-account invariant: one connection per (project, toolkit). See git history
    // on composio_connections for the full rationale (per-project user_id routing).
    uniqueIndex('mcp_connections_project_toolkit_uq').on(t.projectId, t.toolkitSlug),
    index('mcp_connections_project_idx').on(t.projectId),
  ],
);
```

Replace the type export (was line 397):

```ts
export type McpConnection = typeof mcpConnections.$inferSelect;
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`

`strict: true` makes drizzle-kit **prompt** about the table rename. This step is interactive — run it in a real terminal (in Claude Code, prefix with `!` so the user runs it):

- When asked whether `mcp_connections` is **created** or **renamed**, choose **renamed from `composio_connections`**.
- If it asks about the indexes, choose **renamed** too.

Expected: a new `migrations/0017_*.sql` plus updated `migrations/meta/_journal.json` and a new `0017_snapshot.json`.

- [ ] **Step 3: Verify (and if needed, fix) the generated SQL**

Open the new `migrations/0017_*.sql`. It MUST rename rather than drop/create (to preserve data + grants). The correct body is:

```sql
ALTER TABLE "composio_connections" RENAME TO "mcp_connections";--> statement-breakpoint
ALTER INDEX "composio_connections_project_toolkit_uq" RENAME TO "mcp_connections_project_toolkit_uq";--> statement-breakpoint
ALTER INDEX "composio_connections_project_idx" RENAME TO "mcp_connections_project_idx";--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "source" text DEFAULT 'composio' NOT NULL;
```

If drizzle instead emitted `DROP TABLE "composio_connections"` + `CREATE TABLE "mcp_connections"` (it guessed "create" not "rename"), replace the SQL body with the four statements above. **Keep the generated `0017_snapshot.json` and journal entry as-is** — the snapshot reflects the desired end-state regardless of whether the SQL path is rename or create, so hand-editing only the `.sql` keeps drizzle in sync.

Note on grants: `ALTER TABLE … RENAME` preserves existing privileges (it's the same object), so the `mc_agent`/`cc_agent` grants from migration `0015` carry over — no new GRANT block is needed.

- [ ] **Step 4: Apply the migration to the dev branch**

Run: `npm run db:migrate`
Expected: applies `0017_*`, no errors.

- [ ] **Step 5: Prove the snapshot is in sync**

Run: `npm run db:generate`
Expected: `No schema changes, nothing to migrate` (proves schema.ts ↔ snapshot ↔ DB all agree). If it wants to generate another migration, the snapshot desynced in Step 3 — delete the spurious output and redo Step 3.

- [ ] **Step 6: Commit**

```bash
git add lib/db/schema.ts migrations/
git commit -m "refactor(db): rename composio_connections -> mcp_connections, add source column"
```

---

## Task 2: Update the DB store to the renamed symbol

**Files:**
- Modify: `lib/composio-store.ts:6` (import) and its query builders (`getConnection`, `listConnectionsByProject`, `upsertConnection`, `setConnectionStatus` — lines ~29–76)
- Test: `test/composio-store.test.ts` (existing — the safety net)

- [ ] **Step 1: Add a failing assertion for the `source` default**

In `test/composio-store.test.ts`, add a test that a newly-upserted connection reports `source: 'composio'`. Match the existing test style (a project is created in setup; reuse that helper/fixture). Example:

```ts
it('defaults source to composio on upsert', async () => {
  const conn = await upsertConnection(projectId, 'linear', { userId: 'mc-proj-x', status: 'initializing' });
  expect(conn.source).toBe('composio');
});
```

(If `upsertConnection` does not currently return the row, instead read it back via `getConnection(projectId, 'linear')` and assert `.source`.)

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run test/composio-store.test.ts -t "defaults source"`
Expected: FAIL — either a TS/import error on `composioConnections` (now renamed) or `source` is `undefined`.

- [ ] **Step 3: Update the import + usages**

In `lib/composio-store.ts`, change the schema import (line 6) from `composioConnections` to `mcpConnections`, and update every `.from(composioConnections)` / `.insert(composioConnections)` / `.update(composioConnections)` / `eq(composioConnections.…)` to `mcpConnections`. Update the imported type `ComposioConnection` → `McpConnection` wherever the file annotates it. Leave all `composioToolkits` references untouched.

- [ ] **Step 4: Run the store test green**

Run: `npx vitest run test/composio-store.test.ts`
Expected: PASS (including the new `source` assertion).

- [ ] **Step 5: Commit**

```bash
git add lib/composio-store.ts test/composio-store.test.ts
git commit -m "refactor: point composio-store at mcpConnections; assert source default"
```

---

## Task 3: Rename the CLI namespace `mc composio` → `mc mcp` (and `mcp-config` → `config`)

**Files:**
- Modify: `cli/index.ts:355-361` (SPEC entries), `cli/index.ts:886` (command group), `cli/index.ts:888-1003` (7 subcommand registrations + help text on ~line 918)

- [ ] **Step 1: Rename the SPEC entries**

In `cli/index.ts` lines 355–361, change each `name` from `composio …` to `mcp …`, and rename the `mcp-config` entry to `config`:

```ts
  { name: 'mcp catalog', readonly: true, summary: 'List supported Composio toolkits' },
  { name: 'mcp connect', readonly: false, summary: 'Start a Composio connection (prints authorize link)', args: ['<slug>', '<toolkit>'] },
  { name: 'mcp status', readonly: false, summary: 'Poll a Composio connection status', args: ['<slug>', '<toolkit>'] },
  { name: 'mcp list', readonly: true, summary: "List a project's MCP connections", args: ['<slug>'] },
  { name: 'mcp disconnect', readonly: false, summary: 'Disconnect a Composio toolkit', args: ['<slug>', '<toolkit>'] },
  { name: 'mcp config', readonly: true, summary: "Resolve a project's active connections into an mcpServers map", args: ['<slug>'] },
  { name: 'mcp refresh', readonly: false, summary: "Re-poll a project's MCP connections; emit events on status changes", args: ['<slug>'] },
```

- [ ] **Step 2: Rename the command group + subcommands**

At line 886, change:

```ts
const mcp = program.command('mcp').description('Manage MCP server connections (Composio toolkits + remote)');
```

Then in the 7 blocks below it, change every `composio.command('…')` to `mcp.command('…')`, and change the `mcp-config` registration to `config`:

```ts
const cfg = mcp.command('config');   // was composio.command('mcp-config')
```

Update the help/log text near line 918 that says `Then: mc composio status …` to `Then: mc mcp status …`.

- [ ] **Step 3: Smoke-test the renamed CLI**

Run (read-only, no DB writes):

```bash
node cli/index.js mcp catalog --json
node cli/index.js spec --json | grep -c '"mcp '
node cli/index.js spec --json | grep -c '"composio '
```

Expected: `mcp catalog` returns its catalog envelope; the `mcp ` grep counts 7; the `composio ` grep counts 0. (Adjust `cli/index.js` to the actual built/entry path if the repo runs the TS entry directly, e.g. `tsx cli/index.ts`.)

- [ ] **Step 4: Commit**

```bash
git add cli/index.ts
git commit -m "refactor(cli): rename mc composio -> mc mcp; mcp-config -> config"
```

---

## Task 4: Update the daemon's CLI call

**Files:**
- Modify: `daemon/runner.ts:79-89`

- [ ] **Step 1: Update the call + log wording**

In `fetchComposioMcpServers` (lines 79–89), change line 80 from:

```ts
const cfg = await mc(['composio', 'mcp-config', projectSlug]);
```

to:

```ts
const cfg = await mc(['mcp', 'config', projectSlug]);
```

Update the two log strings (lines ~82, ~87) to say `mcp config` / `mcp server(s)` instead of `composio mcp-config` / `composio server(s)`. **Leave the `composio-` prefix stripping on line ~86 unchanged** — the mcpServers keys are still `composio-<toolkit>` this slice (byte-identical), so the prefix logic must stay.

- [ ] **Step 2: Run the daemon-render test**

Run: `npx vitest run test/daemon-render.test.ts`
Expected: PASS. (If a test stubs the `mc(...)` call by matching the argv `['composio','mcp-config',…]`, update that stub's matcher to `['mcp','config',…]`.)

- [ ] **Step 3: Commit**

```bash
git add daemon/runner.ts test/daemon-render.test.ts
git commit -m "refactor(daemon): call mc mcp config for the spawn auto-feed"
```

---

## Task 5: Update docs + sweep remaining command-string references, full green suite

**Files:**
- Modify: `AGENTS.md:50-56`
- Modify: any test asserting CLI command strings (found via grep below)

- [ ] **Step 1: Update AGENTS.md**

In `AGENTS.md` lines 50–56, change each `mc composio …` to `mc mcp …` and rename `mc composio mcp-config` to `mc mcp config`. Keep the word "Composio" inside the descriptions (it's the service name). Example for the first two lines:

```
mc mcp catalog                               # list supported Composio toolkits (slug, name, tool count); no DB needed; reads COMPOSIO_API_KEY from host env (never stored)
mc mcp connect <slug> <toolkit>              # start a connection; prints OAuth authorize URL; follow up with mc mcp status. At most one connection per (project, toolkit)
```

Apply the same `mc composio` → `mc mcp` change to the remaining five lines, and `mcp-config` → `config` on the config line.

- [ ] **Step 2: Find any remaining command-string references**

Run: `grep -rn "composio mcp-config\|'composio'\|\"composio\"\|mc composio" --include=*.ts --include=*.tsx test/ cli/ daemon/ lib/ app/`
Expected: results are only legitimate Composio-service references (e.g. `composio-api`, the `composio-` server-key prefix, `composio_toolkits`, the route dir). Any **CLI command-string** like `['composio', …]` or `mc composio` in a test must be updated to the `mcp`/`config` form. Update each one found.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all green. Any failure at this point is a leftover command-string or schema-symbol reference — fix it and re-run.

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit && ./node_modules/.bin/biome check .`
Expected: no errors. (Per repo memory: invoke biome via its binary directly — `pnpm lint`/`eslint` is misrouted locally.)

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md test/
git commit -m "docs: mc composio -> mc mcp in AGENTS.md; sweep command-string refs"
```

---

## Self-Review

**Spec coverage (slice 1 scope):**
- Table `composio_connections` → `mcp_connections` + `source` column → Task 1. ✓
- CLI `mc composio` → `mc mcp`, `mcp-config` → `config` → Task 3. ✓
- Daemon call updated → Task 4. ✓
- Docs/AGENTS.md updated → Task 5. ✓
- Byte-identical behavior: `composio_toolkits`, `composio-*` file names, `composio-` server-key prefix, the route, and the integration node are explicitly untouched. ✓
- Deferred (correctly out of slice 1): full catalog (slice 2), remote servers (slice 3), MCP tab UI (slice 4), legacy `mc integration` removal (slice 5).

**Placeholder scan:** No TBD/TODO. The one "find via grep" step (Task 5 Step 2) supplies the exact grep and the exact disposition rule (update CLI command-strings, leave service references) — not a placeholder.

**Type consistency:** `mcpConnections` (symbol) ↔ `mcp_connections` (table) ↔ `McpConnection` (type) used consistently across Tasks 1–2. `config` subcommand name matches the daemon argv `['mcp','config',…]` in Task 4. `source` default `'composio'` defined in Task 1 and asserted in Task 2.

**Migration risk note:** Task 1 Steps 3 + 5 are the guardrails — confirm `ALTER … RENAME` (not drop/create) and prove the snapshot re-generates clean.

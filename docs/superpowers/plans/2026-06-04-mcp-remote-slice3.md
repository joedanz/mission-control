# MCP Remote Servers (slice 3 / `slice/mcp-remote`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second MCP source — `remote` — so a user can attach any remote-http MCP server to a project by URL + `${ENV}`-placeholder headers (no OAuth), and have it ride the existing spawn-feed path alongside Composio-brokered toolkits.

**Architecture:** The `mcp_connections` table already carries a `source` discriminator (`'composio' | 'remote'`, default `composio`, added inert in slice 1). This slice makes `remote` real: three nullable columns (`remote_name`, `remote_url`, `remote_headers`), nullable `toolkit_slug`/`user_id` (remote rows leave them null), a partial unique index on `(project_id, remote_name)`, and a `resolveProjectMcpServers` that **unions** composio rows (today's toolkit-mcpUrl join) with remote rows (emitted directly as `{type:'http', url, headers}`). Because the daemon reaches the resolver only through `mc mcp config`, widening the resolver needs no daemon changes. New CLI verbs `mc mcp add-remote` / `mc mcp remove-remote`, and `mc mcp list` becomes source-aware.

**Tech Stack:** TypeScript, Drizzle ORM (Neon Postgres), Commander CLI, Vitest (tests hit the real Neon branch the repo's `.env.local` points at).

---

## Context the implementer needs

- **Spec:** `docs/superpowers/specs/2026-06-04-mcp-connections-design.md` (data-model + CLI tables). This plan is the authority where it refines the spec — see **Deviations** below.
- **Secrets rule:** MC never stores a secret. Header values are `${ENV_VAR}` placeholders; the daemon's `resolvePlaceholders` (`daemon/render-profile.ts:26`) does **substring** substitution at spawn (so `Bearer ${TOKEN}` is valid), and an unset var is fatal there. Validation at `add-remote` time only needs to require ≥1 `${...}` placeholder per header value so a raw secret can't be persisted.
- **Spawn-feed path (unchanged):** `daemon/runner.ts:80 fetchComposioMcpServers` shells `mc mcp config <slug>` → `resolveProjectMcpServers` → `mcpServers` map → `mergeMcpServers(profile, extra)` (profile wins on key collision) → `resolveMcpConfigJson` → `--mcp-config` temp file. We only touch `resolveProjectMcpServers`.
- **CLI conventions:** `withFlags(cmd)` adds `--json/--human`; `emit('<name>', opts, async () => ({data, human}))` is the leaf wrapper; `ensureDbCredentials()` gates DB writes; the `SPEC` array (`cli/index.ts:~355`) must gain an entry per new command (a sync test enforces name parity); repeatable `KEY=VALUE` flags use `.option('--x <kv>', desc, collect, [])` then split on `=` (mirror `--env`, `cli/index.ts:244-249` + the `collect` reducer at `cli/index.ts:166`).
- **Test seam:** store CRUD + resolver are tested against real Neon with self-cleaning random tags (see `test/composio-store.test.ts`, `test/composio-mcp-resolve.test.ts`). Pure builders/validators are mocked-free unit tests.
- **Gates (per repo):** `npx eslint <changed files>` (NOT `npm run lint`), `npx tsc --noEmit` (ignore the 4 pre-existing `WorkflowNode` errors in `test/workflow-runner.test.ts`), `npx vitest run` (or targeted files). Migrations apply with `npm run db:migrate` against the configured DATABASE_URL, exactly as slice 1's `0017` was applied.

## Deviations from the spec (intentional, keep the slice focused)

1. **`mc mcp disconnect` stays composio-only.** The spec table shows `disconnect <toolkit-or-name>` handling both sources; this plan keeps `disconnect` for composio (it revokes OAuth at Composio) and adds a dedicated `mc mcp remove-remote <slug> <name>` for remote rows (a row delete, no network). One unambiguous remove path per source is simpler than overloading `disconnect` with a source-sniffing branch. Document this in AGENTS.md.
2. **No `composio-connections.ts` → `mcp-connections.ts` file rename in this slice.** That rename is pure churn across the daemon/CLI/tests and adds zero behavior; defer it (it can ride a later slice). The new remote logic lands in a new `lib/mcp-remote.ts` (pure) plus additions to the existing orchestrator/store files.

## File structure

- `lib/db/schema.ts` — **modify** `mcpConnections`: add `remoteName`/`remoteUrl`/`remoteHeaders`; make `toolkitSlug`/`userId` nullable; add the partial unique index.
- `migrations/0018_*.sql` (+ `meta/_journal.json`, `meta/0018_snapshot.json`) — **generate** via `db:generate`.
- `lib/composio-store.ts` — **add** `getRemoteConnection` / `upsertRemoteConnection` / `deleteRemoteConnection`.
- `lib/mcp-remote.ts` — **create** pure `buildRemoteMcpServers` + `validateRemoteInput` (no DB/network).
- `lib/composio-connections.ts` — **add** `addRemote` / `removeRemote`; **extend** `resolveProjectMcpServers` to union; **fix** a null-guard in `refreshConnections`.
- `cli/index.ts` — **add** `mc mcp add-remote` / `mc mcp remove-remote`; **update** `mc mcp list` rendering; **add** two `SPEC` entries.
- `test/composio-store.test.ts`, `test/mcp-remote.test.ts` (new), `test/composio-mcp-resolve.test.ts` — tests.
- `AGENTS.md` — **document** the two new verbs + source-aware `list`/`config`.

---

### Task 1: Schema columns + migration

**Files:**
- Modify: `lib/db/schema.ts` (the `mcpConnections` table, ~`lib/db/schema.ts:364-398`)
- Generate: `migrations/0018_*.sql` + `migrations/meta/_journal.json` + `migrations/meta/0018_snapshot.json`

- [ ] **Step 1: Make `toolkitSlug`/`userId` nullable + add remote columns**

In `lib/db/schema.ts`, inside the `mcpConnections` table definition, change these two lines to drop `.notNull()` (and update the trailing comments):

```ts
    // Composio source only (remote rows leave these null).
    toolkitSlug: text('toolkit_slug'),
    userId: text('user_id'), // mc-proj-<projectId> — the Composio user_id (composio source only)
```

Then, immediately after the `error: text('error'),` line (before the timestamps), add:

```ts
    // ── Remote source (slice 3) ─────────────────────────────────────────────────
    // A 'remote' connection is a directly-supplied remote-http MCP server (no OAuth). For remote rows
    // toolkitSlug / userId / connectedAccountId are null and these three carry the server. remoteName
    // doubles as the mcpServers map key; remoteHeaders values are ${ENV} placeholders (never a secret —
    // resolved at spawn by the daemon). status is pinned 'active' (remote rows have no lifecycle).
    remoteName: text('remote_name'),
    remoteUrl: text('remote_url'),
    remoteHeaders: jsonb('remote_headers').$type<Record<string, string>>(),
```

- [ ] **Step 2: Add the partial unique index for remote rows**

In the `mcpConnections` index list (the `(t) => [ ... ]` array), after the existing `mcp_connections_project_idx` line, add:

```ts
    // Remote rows are unique per (project, remote_name) — a partial index so it ignores composio rows
    // (remote_name null). Composio uniqueness stays on (project, toolkit_slug) above; toolkit_slug is now
    // nullable, and Postgres treats NULLs as distinct, so remote rows never collide on that index.
    uniqueIndex('mcp_connections_project_remote_uq').on(t.projectId, t.remoteName).where(sql`source = 'remote'`),
```

(`sql`, `jsonb`, `uniqueIndex`, `text` are already imported in this file.)

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate`
Expected: a new `migrations/0018_*.sql` is written containing — `ALTER TABLE "mcp_connections" ALTER COLUMN "toolkit_slug" DROP NOT NULL;`, the same for `user_id`, three `ADD COLUMN` statements (`remote_name`/`remote_url` text, `remote_headers` jsonb), and `CREATE UNIQUE INDEX "mcp_connections_project_remote_uq" ... WHERE source = 'remote';`. The `_journal.json` gains an `idx:18` entry and a `0018_snapshot.json` appears.

- [ ] **Step 4: Sanity-check the generated SQL, then confirm it's complete**

Read the generated `migrations/0018_*.sql`. Confirm it contains exactly the statements in Step 3 and **no** destructive statements against other tables. No GRANT block is needed — new columns/indexes inherit the table-level grants already held by `mc_agent`/`cc_agent`.
Run again: `npm run db:generate`
Expected: "No schema changes, nothing to migrate" (proves the schema and migration agree).

- [ ] **Step 5: Apply the migration**

Run: `npm run db:migrate`
Expected: migration `0018` applies cleanly to the configured Neon DB (so the store/resolver tests in later tasks see the new columns).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v "test/workflow-runner.test.ts"`
Expected: no errors *originating in `lib/`*. Readers of the now-nullable `toolkitSlug`/`userId` (`lib/composio-connections.ts`, `cli/index.ts`) may surface `string | null` errors — those are fixed in Tasks 4 & 5. If any appear in files **not** touched by later tasks, fix them with a null guard. Note (do not yet fix) the expected `lib/composio-connections.ts` and `cli/index.ts` errors.

- [ ] **Step 7: Commit**

```bash
git add lib/db/schema.ts migrations/
git commit -m "feat(mcp): add remote-source columns + partial unique index (slice 3)"
```

---

### Task 2: Remote store CRUD

**Files:**
- Modify: `lib/composio-store.ts`
- Test: `test/composio-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `describe('composio store', ...)` block in `test/composio-store.test.ts`. Add the imports `getRemoteConnection, upsertRemoteConnection, deleteRemoteConnection` to the existing `from '../lib/composio-store'` import.

```ts
  it('inserts a remote connection (source=remote, status=active, composio fields null)', async () => {
    const p = await freshProject();
    const c = await upsertRemoteConnection(p.id, {
      remoteName: 'docs', remoteUrl: 'https://mcp.example.com/sse', remoteHeaders: { Authorization: 'Bearer ${DOCS_TOKEN}' },
    });
    expect(c.source).toBe('remote');
    expect(c.status).toBe('active');
    expect(c.remoteName).toBe('docs');
    expect(c.remoteUrl).toBe('https://mcp.example.com/sse');
    expect(c.remoteHeaders).toEqual({ Authorization: 'Bearer ${DOCS_TOKEN}' });
    expect(c.toolkitSlug).toBeNull();
    expect(c.userId).toBeNull();
  });

  it('upsertRemoteConnection is idempotent on (project, name) — re-add updates url/headers', async () => {
    const p = await freshProject();
    const a = await upsertRemoteConnection(p.id, { remoteName: 'docs', remoteUrl: 'https://old', remoteHeaders: {} });
    const b = await upsertRemoteConnection(p.id, { remoteName: 'docs', remoteUrl: 'https://new', remoteHeaders: { X: '${Y}' } });
    expect(b.id).toBe(a.id);
    expect(b.remoteUrl).toBe('https://new');
    expect(b.remoteHeaders).toEqual({ X: '${Y}' });
    expect((await listConnectionsByProject(p.id)).length).toBe(1);
  });

  it('getRemoteConnection / deleteRemoteConnection round-trip; delete returns the row then null', async () => {
    const p = await freshProject();
    await upsertRemoteConnection(p.id, { remoteName: 'docs', remoteUrl: 'https://x', remoteHeaders: {} });
    expect((await getRemoteConnection(p.id, 'docs'))?.remoteUrl).toBe('https://x');
    expect((await deleteRemoteConnection(p.id, 'docs'))?.remoteName).toBe('docs');
    expect(await getRemoteConnection(p.id, 'docs')).toBeNull();
    expect(await deleteRemoteConnection(p.id, 'docs')).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/composio-store.test.ts`
Expected: FAIL — `upsertRemoteConnection`/`getRemoteConnection`/`deleteRemoteConnection` are not exported.

- [ ] **Step 3: Implement the store functions**

In `lib/composio-store.ts`, add `sql` to the drizzle-orm import (`import { eq, and, sql } from 'drizzle-orm';`). Append:

```ts
export async function getRemoteConnection(projectId: string, remoteName: string): Promise<McpConnection | null> {
  const rows = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.projectId, projectId), eq(mcpConnections.source, 'remote'), eq(mcpConnections.remoteName, remoteName)))
    .limit(1);
  return rows[0] ?? null;
}

/** Upsert a remote-source MCP server row (source='remote', status pinned 'active'). Idempotent on
 *  (project, remote_name) via the partial unique index — a re-add updates url + headers. */
export async function upsertRemoteConnection(
  projectId: string,
  patch: { remoteName: string; remoteUrl: string; remoteHeaders: Record<string, string> },
): Promise<McpConnection> {
  const rows = await db
    .insert(mcpConnections)
    .values({
      projectId,
      source: 'remote',
      status: 'active',
      remoteName: patch.remoteName,
      remoteUrl: patch.remoteUrl,
      remoteHeaders: patch.remoteHeaders,
    })
    .onConflictDoUpdate({
      target: [mcpConnections.projectId, mcpConnections.remoteName],
      targetWhere: sql`source = 'remote'`,
      set: { remoteUrl: patch.remoteUrl, remoteHeaders: patch.remoteHeaders, updatedAt: new Date() },
    })
    .returning();
  return rows[0];
}

export async function deleteRemoteConnection(projectId: string, remoteName: string): Promise<McpConnection | null> {
  const rows = await db
    .delete(mcpConnections)
    .where(and(eq(mcpConnections.projectId, projectId), eq(mcpConnections.source, 'remote'), eq(mcpConnections.remoteName, remoteName)))
    .returning();
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/composio-store.test.ts`
Expected: PASS (all, including the 6 pre-existing).

- [ ] **Step 5: Lint + commit**

```bash
npx eslint lib/composio-store.ts test/composio-store.test.ts
git add lib/composio-store.ts test/composio-store.test.ts
git commit -m "feat(mcp): remote-connection store CRUD (slice 3)"
```

---

### Task 3: Pure remote builder + input validation

**Files:**
- Create: `lib/mcp-remote.ts`
- Test: `test/mcp-remote.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/mcp-remote.test.ts`:

```ts
// ABOUTME: Pure remote-MCP helpers — build the mcpServers entry + validate add-remote input. No DB/network.

import { describe, it, expect } from 'vitest';
import { buildRemoteMcpServers, validateRemoteInput } from '../lib/mcp-remote';
import { ValidationError } from '../lib/validation';

describe('buildRemoteMcpServers', () => {
  it('emits one http entry per row, keyed by remoteName, headers preserved verbatim', () => {
    const map = buildRemoteMcpServers([
      { remoteName: 'docs', remoteUrl: 'https://a/sse', remoteHeaders: { Authorization: 'Bearer ${T}' } },
      { remoteName: 'wiki', remoteUrl: 'https://b/mcp', remoteHeaders: null },
    ]);
    expect(map).toEqual({
      docs: { type: 'http', url: 'https://a/sse', headers: { Authorization: 'Bearer ${T}' } },
      wiki: { type: 'http', url: 'https://b/mcp' },
    });
  });

  it('omits the headers key when the row has an empty header map', () => {
    const map = buildRemoteMcpServers([{ remoteName: 'docs', remoteUrl: 'https://a', remoteHeaders: {} }]);
    expect(map.docs).toEqual({ type: 'http', url: 'https://a' });
  });
});

describe('validateRemoteInput', () => {
  it('accepts a valid name + https URL + ${ENV} headers', () => {
    const out = validateRemoteInput({ name: ' docs ', url: 'https://a/sse', headers: { Authorization: 'Bearer ${T}' } });
    expect(out).toEqual({ name: 'docs', url: 'https://a/sse', headers: { Authorization: 'Bearer ${T}' } });
  });

  it('rejects an empty name', () => {
    expect(() => validateRemoteInput({ name: '  ', url: 'https://a', headers: {} })).toThrow(ValidationError);
  });

  it('rejects a non-http(s) URL', () => {
    expect(() => validateRemoteInput({ name: 'x', url: 'ftp://a', headers: {} })).toThrow(ValidationError);
    expect(() => validateRemoteInput({ name: 'x', url: 'not a url', headers: {} })).toThrow(ValidationError);
  });

  it('rejects a header value with no ${ENV} placeholder (would persist a literal secret)', () => {
    expect(() => validateRemoteInput({ name: 'x', url: 'https://a', headers: { Authorization: 'Bearer sk-raw-secret' } })).toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/mcp-remote.test.ts`
Expected: FAIL — `../lib/mcp-remote` does not exist.

- [ ] **Step 3: Implement the module**

Create `lib/mcp-remote.ts`:

```ts
// ABOUTME: Pure helpers for 'remote'-source MCP connections — build the mcpServers entry + validate
// ABOUTME: operator input (URL + ${ENV}-placeholder headers). No DB, no network.

import type { McpServerConfig } from './db/schema';
import { ValidationError } from './validation';

// A header value must reference at least one ${ENV_VAR} placeholder so a raw secret can't be persisted;
// the daemon substring-substitutes these at spawn (Bearer ${TOKEN} is valid).
const PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

/** One already-loaded remote-source row: the inputs to emit a single mcpServers entry. */
export type RemoteMcpRow = { remoteName: string; remoteUrl: string; remoteHeaders: Record<string, string> | null };

/** Build the mcpServers map from remote-source rows. Each row → one http entry keyed by its remoteName,
 *  carrying the stored ${ENV}-placeholder headers (the daemon resolves them at spawn, never here). The
 *  headers key is omitted when the row has none. */
export function buildRemoteMcpServers(rows: RemoteMcpRow[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const { remoteName, remoteUrl, remoteHeaders } of rows) {
    out[remoteName] = {
      type: 'http',
      url: remoteUrl,
      ...(remoteHeaders && Object.keys(remoteHeaders).length ? { headers: remoteHeaders } : {}),
    };
  }
  return out;
}

/** Validate + normalize operator input for `mc mcp add-remote`. Trims the name; requires an http(s) URL;
 *  requires every header value to reference an ${ENV_VAR} placeholder. Throws ValidationError otherwise. */
export function validateRemoteInput(input: { name: string; url: string; headers: Record<string, string> }): {
  name: string;
  url: string;
  headers: Record<string, string>;
} {
  const name = input.name.trim();
  if (!name) throw new ValidationError('name', 'a remote server needs a non-empty --name');
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new ValidationError('url', `not a valid URL: ${input.url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('url', `--url must be http(s): ${input.url}`);
  }
  for (const [k, v] of Object.entries(input.headers)) {
    if (!PLACEHOLDER.test(v)) {
      throw new ValidationError('header', `header "${k}" must reference an \${ENV_VAR} placeholder, not a literal secret`);
    }
  }
  return { name, url: input.url, headers: input.headers };
}
```

Before writing, confirm `ValidationError`'s constructor signature in `lib/validation.ts` is `(field, message)` (it's used as `new ValidationError('mcp-config', '...')` in `cli/index.ts`). Match it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/mcp-remote.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
npx eslint lib/mcp-remote.ts test/mcp-remote.test.ts
git add lib/mcp-remote.ts test/mcp-remote.test.ts
git commit -m "feat(mcp): pure remote builder + add-remote input validation (slice 3)"
```

---

### Task 4: Orchestration — addRemote / removeRemote + resolver union

**Files:**
- Modify: `lib/composio-connections.ts`
- Test: `test/composio-mcp-resolve.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/composio-mcp-resolve.test.ts`, add `upsertRemoteConnection` to the `from '../lib/composio-store'` import, and add these cases inside the `describe('resolveProjectMcpServers (real Neon)', ...)` block:

```ts
  it('emits a remote-source connection as a direct http entry (headers preserved)', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    await upsertRemoteConnection(p.id, {
      remoteName: 'docs', remoteUrl: 'https://mcp.example.com/sse', remoteHeaders: { Authorization: 'Bearer ${DOCS_TOKEN}' },
    });
    const map = await resolveProjectMcpServers(p.slug);
    expect(map.docs).toEqual({ type: 'http', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } });
  });

  it('unions composio + remote sources in one map', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    const lin = tag();
    toolkitSlugs.push(lin);
    await upsertToolkitRow(lin, { mcpUrl: `https://x/v3/mcp/${lin}` });
    await upsertConnection(p.id, lin, { userId: `mc-proj-${p.id}`, status: 'active', connectedAccountId: 'ca_1' });
    await upsertRemoteConnection(p.id, { remoteName: 'docs', remoteUrl: 'https://r/sse', remoteHeaders: {} });

    const map = await resolveProjectMcpServers(p.slug);
    expect(Object.keys(map).sort()).toEqual([`composio-${lin}`, 'docs']);
    expect(map[`composio-${lin}`].url).toBe(`https://x/v3/mcp/${lin}?user_id=mc-proj-${p.id}`);
    expect(map.docs).toEqual({ type: 'http', url: 'https://r/sse' });
  });
```

Also add a test that `addRemote`/`removeRemote` orchestrate validation + the store. Add a new file `test/mcp-remote-orchestration.test.ts` (keeps the resolver test focused on the resolver):

```ts
// ABOUTME: addRemote / removeRemote orchestration against real Neon — validates input, persists, removes.

import { describe, it, expect, afterEach } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects } from '../lib/db/schema';
import { createProject } from '../lib/mutations';
import { addRemote, removeRemote } from '../lib/composio-connections';
import { ValidationError, NotFoundError } from '../lib/validation';

const projectIds: string[] = [];
const tag = () => `vt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

afterEach(async () => {
  if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
  projectIds.length = 0;
});

describe('addRemote / removeRemote (real Neon)', () => {
  it('addRemote validates + persists; removeRemote deletes', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    const c = await addRemote(p.slug, { name: 'docs', url: 'https://r/sse', headers: { Authorization: 'Bearer ${T}' } });
    expect(c.source).toBe('remote');
    expect(c.status).toBe('active');
    const removed = await removeRemote(p.slug, 'docs');
    expect(removed.remoteName).toBe('docs');
  });

  it('addRemote rejects a literal-secret header', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    await expect(addRemote(p.slug, { name: 'docs', url: 'https://r', headers: { Authorization: 'sk-raw' } })).rejects.toBeInstanceOf(ValidationError);
  });

  it('removeRemote throws NotFoundError for an unknown name', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    await expect(removeRemote(p.slug, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/composio-mcp-resolve.test.ts test/mcp-remote-orchestration.test.ts`
Expected: FAIL — `addRemote`/`removeRemote` not exported; remote rows not yet unioned by the resolver.

- [ ] **Step 3: Implement the orchestration + resolver union**

In `lib/composio-connections.ts`:

(a) Extend the store import to include the remote functions:
```ts
import { getToolkitRow, upsertToolkitRow, getConnection, listConnectionsByProject, upsertConnection, setConnectionStatus, upsertRemoteConnection, deleteRemoteConnection } from './composio-store';
```

(b) Add the remote builder import next to the composio one:
```ts
import { buildConnectionMcpServers, type ConnectionMcpRow } from './composio-mcp';
import { buildRemoteMcpServers, validateRemoteInput, type RemoteMcpRow } from './mcp-remote';
```

(c) Replace the body of `resolveProjectMcpServers` with the union (branch on `source`, guard the now-nullable composio fields):
```ts
export async function resolveProjectMcpServers(projectSlug: string): Promise<Record<string, McpServerConfig>> {
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  const active = (await listConnectionsByProject(projectId)).filter((c) => c.status === 'active');
  // composio rows → join each toolkit's cached mcpUrl (a row with no cached url, or missing slug/user, is skipped)
  const joined = await Promise.all(
    active
      .filter((c) => c.source === 'composio')
      .map(async (c) => {
        if (!c.toolkitSlug || !c.userId) return null;
        const toolkit = await getToolkitRow(c.toolkitSlug);
        return toolkit?.mcpUrl ? { toolkitSlug: c.toolkitSlug, userId: c.userId, mcpUrl: toolkit.mcpUrl } : null;
      }),
  );
  const composioRows: ConnectionMcpRow[] = joined.filter((r): r is ConnectionMcpRow => r !== null);
  // remote rows → emit directly (no cache/network); a malformed row missing name/url is skipped
  const remoteRows: RemoteMcpRow[] = active
    .filter((c) => c.source === 'remote' && c.remoteName && c.remoteUrl)
    .map((c) => ({ remoteName: c.remoteName!, remoteUrl: c.remoteUrl!, remoteHeaders: c.remoteHeaders }));
  return { ...buildConnectionMcpServers(composioRows), ...buildRemoteMcpServers(remoteRows) };
}
```

(d) Add the two orchestration functions (place them after `disconnect`):
```ts
/** Attach a remote-http MCP server to a project (no OAuth). Validates input, then upserts a remote row
 *  (idempotent on name). The server is immediately active. */
export async function addRemote(
  projectSlug: string,
  input: { name: string; url: string; headers: Record<string, string> },
): Promise<McpConnection> {
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  const { name, url, headers } = validateRemoteInput(input);
  return upsertRemoteConnection(projectId, { remoteName: name, remoteUrl: url, remoteHeaders: headers });
}

/** Detach a remote MCP server by name. NotFoundError if no such remote row. */
export async function removeRemote(projectSlug: string, name: string): Promise<McpConnection> {
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  const removed = await deleteRemoteConnection(projectId, name);
  if (!removed) throw new NotFoundError('remote connection', `${projectSlug}/${name}`);
  return removed;
}
```

(e) Fix the `refreshConnections` null-guard so remote rows (and the now-nullable `toolkitSlug`) typecheck. Change the loop's skip line from `if (!conn.connectedAccountId) continue;` to:
```ts
    if (!conn.connectedAccountId || !conn.toolkitSlug) continue; // never-linked or remote rows → nothing to poll
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/composio-mcp-resolve.test.ts test/mcp-remote-orchestration.test.ts`
Expected: PASS (including the 3 pre-existing resolver cases).

- [ ] **Step 5: Typecheck + lint + commit**

```bash
npx tsc --noEmit 2>&1 | grep -v "test/workflow-runner.test.ts"   # expect no lib/ errors; cli/index.ts errors fixed in Task 5
npx eslint lib/composio-connections.ts test/composio-mcp-resolve.test.ts test/mcp-remote-orchestration.test.ts
git add lib/composio-connections.ts test/composio-mcp-resolve.test.ts test/mcp-remote-orchestration.test.ts
git commit -m "feat(mcp): addRemote/removeRemote + resolver unions remote sources (slice 3)"
```

---

### Task 5: CLI verbs + source-aware list + spec + docs

**Files:**
- Modify: `cli/index.ts` (the `mcp` command group ~`cli/index.ts:885-1007` and the `SPEC` array ~`cli/index.ts:355-361`)
- Modify: `AGENTS.md`

- [ ] **Step 1: Add the two SPEC entries**

In the `SPEC` array, after the `{ name: 'mcp connect', ... }` line, add:

```ts
  { name: 'mcp add-remote', readonly: false, summary: 'Attach a remote-http MCP server (URL + ${ENV} headers)', args: ['<slug>'], required: ['--name', '--url'], options: ['--header'] },
  { name: 'mcp remove-remote', readonly: false, summary: 'Detach a remote MCP server by name', args: ['<slug>', '<name>'] },
```

- [ ] **Step 2: Add the `add-remote` and `remove-remote` commands**

In `cli/index.ts`, after the `mcp connect` command block (ends ~`cli/index.ts:926`), add. Reuse the existing `collect` reducer (`cli/index.ts:166`) for the repeatable `--header` flag, and parse `KEY=VALUE` exactly like `--env` (`cli/index.ts:246-249`):

```ts
withFlags(mcp.command('add-remote'))
  .description('Attach a remote-http MCP server (URL + ${ENV} headers)')
  .argument('<slug>')
  .requiredOption('--name <name>', 'display name (also the mcpServers key)')
  .requiredOption('--url <url>', 'remote MCP endpoint URL (http/https)')
  .option('--header <kv>', 'repeatable header KEY=VALUE (use ${ENV} for secrets)', collect, [])
  .action((slug: string, opts: LeafOpts) =>
    emit('mcp add-remote', opts, async () => {
      ensureDbCredentials();
      const headers = Object.fromEntries(
        ((opts.header as string[]) ?? []).map((kv) => {
          const i = kv.indexOf('=');
          if (i < 0) throw new ValidationError('header', `Invalid --header "${kv}" — expected KEY=VALUE`);
          return [kv.slice(0, i), kv.slice(i + 1)];
        }),
      );
      const { addRemote } = await import('../lib/composio-connections');
      const connection = await addRemote(slug, { name: String(opts.name), url: String(opts.url), headers });
      return { data: connection, human: () => console.log(`${slug}: remote "${connection.remoteName}" added (${connection.status})`) };
    }),
  );

withFlags(mcp.command('remove-remote'))
  .description('Detach a remote MCP server by name')
  .argument('<slug>')
  .argument('<name>')
  .action((slug: string, name: string, opts: LeafOpts) =>
    emit('mcp remove-remote', opts, async () => {
      ensureDbCredentials();
      const { removeRemote } = await import('../lib/composio-connections');
      const connection = await removeRemote(slug, name);
      return { data: connection, human: () => console.log(`${slug}: remote "${connection.remoteName}" removed`) };
    }),
  );
```

Confirm `collect` and `ValidationError` are already in scope at the top of `cli/index.ts` (they are — `collect` at line 166, `ValidationError` imported from `./validation`).

- [ ] **Step 3: Make `mc mcp list` source-aware**

Replace the `human` renderer in the `mcp list` command (~`cli/index.ts:951-954`) so it labels each row by source and shows the right identifier (composio: `toolkitSlug`; remote: `remoteName`). This also fixes the `string | null` typecheck on `c.toolkitSlug`:

```ts
      return {
        data: { items, count: items.length },
        human: () => {
          items.forEach((c) =>
            console.log(`${c.source === 'remote' ? 'remote' : 'composio'}  ${c.remoteName ?? c.toolkitSlug ?? '?'}  ${c.status}`),
          );
          console.log(`\n${items.length} connection${items.length === 1 ? '' : 's'}`);
        },
      };
```

- [ ] **Step 4: Run the spec-sync + CLI tests**

Run: `npx vitest run test/cli-spec.test.ts test/composio-view.test.ts` (use whichever test enforces `SPEC` ↔ command parity — find it with `grep -rl "mc spec\|SPEC" test/`).
Expected: PASS — the two new commands have matching `SPEC` entries.

- [ ] **Step 5: Smoke the new commands against the live DB**

Find a real project slug: `mc project list --json` (pick any slug). Then:
```bash
mc mcp add-remote <slug> --name smoke-docs --url https://mcp.example.com/sse --header 'Authorization=Bearer ${SMOKE_TOKEN}' --json
mc mcp list <slug> --json          # the remote row appears, source=remote, status=active
mc mcp config <slug> --json        # mcpServers includes "smoke-docs": {type:http,url,headers}
mc mcp remove-remote <slug> smoke-docs --json
```
Also verify validation rejects a literal secret (non-zero exit, VALIDATION code):
```bash
mc mcp add-remote <slug> --name bad --url https://x --header 'Authorization=Bearer rawsecret' --json
```
Expected: the add/list/config/remove round-trip succeeds; the literal-secret add fails with `error.code = VALIDATION`. Clean up any smoke row you created.

- [ ] **Step 6: Typecheck + lint**

```bash
npx tsc --noEmit 2>&1 | grep -v "test/workflow-runner.test.ts"   # expect clean
npx eslint cli/index.ts
```
Expected: no errors.

- [ ] **Step 7: Update AGENTS.md**

In `AGENTS.md`, in the `mc` command reference block, after the `mc mcp connect …` line add two lines documenting `mc mcp add-remote <slug> --name <n> --url <u> [--header K=V …]` (a `remote`-source MCP server, no OAuth, status pinned active, header values are `${ENV}` placeholders resolved at spawn, `--name` doubles as the mcpServers key) and `mc mcp remove-remote <slug> <name>`. Update the `mc mcp list` / `mc mcp config` descriptions to note they now include **both** composio and remote sources. Note that `mc mcp disconnect` remains composio-only (remote rows use `remove-remote`).

- [ ] **Step 8: Commit**

```bash
git add cli/index.ts AGENTS.md
git commit -m "feat(mcp): mc mcp add-remote/remove-remote + source-aware list; docs (slice 3)"
```

---

### Task 6: Full gate sweep

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all green (the prior count + the new remote tests). Note the new total.

- [ ] **Step 2: Typecheck (whole repo)**

Run: `npx tsc --noEmit 2>&1 | grep -v "test/workflow-runner.test.ts"`
Expected: no output (only the 4 known pre-existing `WorkflowNode` errors are filtered).

- [ ] **Step 3: Lint the full changed set**

Run: `npx eslint lib/db/schema.ts lib/composio-store.ts lib/mcp-remote.ts lib/composio-connections.ts cli/index.ts test/composio-store.test.ts test/mcp-remote.test.ts test/mcp-remote-orchestration.test.ts test/composio-mcp-resolve.test.ts`
Expected: clean.

- [ ] **Step 4: Confirm no stray `mc composio` / behavior regressions**

Run: `git diff main --stat` and skim. Confirm the daemon files are untouched (the resolver change reaches them transparently via `mc mcp config`).

---

## Review

_(Filled in after implementation.)_

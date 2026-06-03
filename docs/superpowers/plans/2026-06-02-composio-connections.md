# Composio Connection Storage + Connect Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-project Composio connection lifecycle (storage + connect/poll/list/disconnect) for long-tail toolkits (Linear, Slack), exercised via `mc composio` commands — the data layer the reshaped Integrations tab and profile auto-feed build on.

**Architecture:** Three clean layers: `lib/composio-api.ts` (Composio v3 HTTP, no DB), `lib/composio-store.ts` (DB CRUD for two new tables, no network), `lib/composio-connections.ts` (orchestration composing the two). A static `lib/composio-catalog.ts` holds supported toolkits + allow-lists. `mc composio` commands drive it. No UI.

**Tech Stack:** Drizzle + Neon Postgres, TypeScript, `fetch` (no SDK; Vercel-safe), commander (`mc`), Vitest (node, real Neon for DB tests; mocked `fetch` for API tests).

**Spec:** `docs/superpowers/specs/2026-06-02-composio-connections-design.md`

---

## File Structure

- **Create** `lib/composio-catalog.ts` — static supported-toolkit catalog (slug → name + allow-list). One responsibility: the editorial list of what's connectable.
- **Create** `lib/composio-api.ts` — Composio v3 HTTP client + pure helpers (`deriveUserId`, `mapStatus`, `deriveMcpUrl`). No DB. Vercel-safe `fetch`.
- **Create** `lib/composio-store.ts` — DB CRUD for `composio_toolkits` + `composio_connections`. No network. The DB-testable seam.
- **Create** `lib/composio-connections.ts` — orchestration (`ensureToolkit`, `connectStart`, `connectPoll`, `listConnections`, `disconnect`) composing store + api.
- **Modify** `lib/db/schema.ts` — add the two tables + inferred types.
- **Create** `migrations/00XX_*.sql` (drizzle-generated) — the two tables; hand-append grants.
- **Modify** `cli/index.ts` — `mc composio` command group + spec-registry entries.
- **Create** `test/composio-catalog.test.ts`, `test/composio-api.test.ts` (mocked fetch), `test/composio-store.test.ts` (real Neon).

---

### Task 1: Catalog + schema + migration

**Files:**
- Create: `lib/composio-catalog.ts`
- Modify: `lib/db/schema.ts`
- Create: `migrations/00XX_<generated>.sql` (drizzle generates the name)
- Create: `test/composio-catalog.test.ts`

- [ ] **Step 1: Write the catalog**

`lib/composio-catalog.ts`:
```ts
// ABOUTME: Static catalog of Composio long-tail toolkits MC supports connecting, with a curated
// ABOUTME: allow-list of tools per toolkit. Editorial data (not runtime state) — lives in code.

export type CatalogEntry = { name: string; allowedTools: string[] };

export const COMPOSIO_CATALOG: Record<string, CatalogEntry> = {
  linear: {
    name: 'Linear',
    allowedTools: [
      'LINEAR_LIST_LINEAR_TEAMS',
      'LINEAR_CREATE_LINEAR_ISSUE',
      'LINEAR_GET_LINEAR_ISSUE',
      'LINEAR_LIST_LINEAR_ISSUES',
    ],
  },
  slack: {
    name: 'Slack',
    allowedTools: [
      'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL',
      'SLACK_LIST_CONVERSATIONS',
      'SLACK_FETCH_CONVERSATION_HISTORY',
    ],
  },
};

/** Look up a catalog entry; null for an unknown slug. */
export function getCatalogEntry(slug: string): CatalogEntry | null {
  return COMPOSIO_CATALOG[slug] ?? null;
}

/** Sorted list of supported toolkit slugs. */
export function catalogSlugs(): string[] {
  return Object.keys(COMPOSIO_CATALOG).sort();
}
```

- [ ] **Step 2: Write the catalog test**

`test/composio-catalog.test.ts`:
```ts
// ABOUTME: Pins the static Composio toolkit catalog — supported slugs + non-empty allow-lists.

import { describe, it, expect } from 'vitest';
import { COMPOSIO_CATALOG, getCatalogEntry, catalogSlugs } from '../lib/composio-catalog';

describe('Composio catalog', () => {
  it('seeds linear and slack with non-empty allow-lists', () => {
    expect(catalogSlugs()).toEqual(['linear', 'slack']);
    for (const slug of catalogSlugs()) {
      const e = COMPOSIO_CATALOG[slug];
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.allowedTools.length).toBeGreaterThan(0);
    }
  });

  it('getCatalogEntry returns null for unknown slugs', () => {
    expect(getCatalogEntry('linear')?.name).toBe('Linear');
    expect(getCatalogEntry('nope')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the catalog test**

Run: `npx vitest run test/composio-catalog.test.ts`
Expected: PASS 2/2.

- [ ] **Step 4: Add the two tables to `lib/db/schema.ts`**

Append at the end of the table definitions (after the last table, before any trailing type exports if the file groups them; place near other tables). Use `import` symbols already present in the file (`pgTable`, `text`, `timestamp`, `uniqueIndex`, `index`, `sql`):

```ts
// ── Composio connections (Integrations reshape) ───────────────────────────────────
// Per-toolkit shared Composio resources (auth-config + MCP server) created once and cached here.
export const composioToolkits = pgTable('composio_toolkits', {
  slug: text('slug').primaryKey(), // matches a COMPOSIO_CATALOG key
  authConfigId: text('auth_config_id'), // Composio ac_… (created once)
  mcpServerId: text('mcp_server_id'), // Composio MCP server id (created once)
  mcpUrl: text('mcp_url'), // base, e.g. https://backend.composio.dev/v3/mcp/<id>
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// One connection per (project, toolkit). Holds only Composio resource IDs — never a secret.
export const composioConnections = pgTable(
  'composio_connections',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    toolkitSlug: text('toolkit_slug').notNull(), // catalog key
    userId: text('user_id').notNull(), // mc-proj-<projectId> — the Composio user_id
    connectedAccountId: text('connected_account_id'), // Composio ca_… (set once link initiated)
    status: text('status').notNull().default('initializing'), // initializing|active|error|expired|disconnected
    linkUrl: text('link_url'), // transient hosted link for an in-flight connect
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('composio_connections_project_toolkit_uq').on(t.projectId, t.toolkitSlug),
    index('composio_connections_project_idx').on(t.projectId),
  ],
);

export type ComposioToolkit = typeof composioToolkits.$inferSelect;
export type ComposioConnection = typeof composioConnections.$inferSelect;
```

- [ ] **Step 5: Generate the migration**

Run: `npm run db:generate`
Expected: a new `migrations/00XX_*.sql` creating both tables. Note the filename.

- [ ] **Step 6: Hand-append the grants**

Append to the generated migration file (mirrors `migrations/0008`'s convention — `mc_agent` if it exists, else `cc_agent`), once per table:

```sql
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mc_agent') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "composio_toolkits" TO mc_agent;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "composio_connections" TO mc_agent;
  ELSIF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cc_agent') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "composio_toolkits" TO cc_agent;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "composio_connections" TO cc_agent;
  END IF;
END $$;
```

- [ ] **Step 7: Apply the migration**

Run: `npm run db:migrate`
Expected: applies cleanly (this hits the DB `.env.local` points at — currently prod, per repo convention; the migration is additive).

- [ ] **Step 8: Commit**

```bash
git add lib/composio-catalog.ts test/composio-catalog.test.ts lib/db/schema.ts migrations/
git commit -m "feat: composio connection schema + toolkit catalog"
```

---

### Task 2: DB store (`lib/composio-store.ts`)

Raw DB CRUD for the two tables — **no Composio network calls**, so it's testable against real Neon.

**Files:**
- Create: `lib/composio-store.ts`
- Create: `test/composio-store.test.ts`

- [ ] **Step 1: Write the store**

`lib/composio-store.ts`:
```ts
// ABOUTME: DB CRUD for composio_toolkits (cached shared resources) + composio_connections (per
// ABOUTME: project+toolkit). No Composio network calls — the DB-testable seam under the orchestration.

import { eq, and } from 'drizzle-orm';
import { db } from './db/index';
import { composioToolkits, composioConnections, type ComposioToolkit, type ComposioConnection } from './db/schema';

export async function getToolkitRow(slug: string): Promise<ComposioToolkit | null> {
  const rows = await db.select().from(composioToolkits).where(eq(composioToolkits.slug, slug)).limit(1);
  return rows[0] ?? null;
}

/** Upsert the cached Composio resource ids for a toolkit (only the provided fields change). */
export async function upsertToolkitRow(
  slug: string,
  patch: { authConfigId?: string; mcpServerId?: string; mcpUrl?: string },
): Promise<ComposioToolkit> {
  const rows = await db
    .insert(composioToolkits)
    .values({ slug, ...patch })
    .onConflictDoUpdate({
      target: composioToolkits.slug,
      set: { ...patch, updatedAt: new Date() },
    })
    .returning();
  return rows[0];
}

export async function getConnection(projectId: string, toolkitSlug: string): Promise<ComposioConnection | null> {
  const rows = await db
    .select()
    .from(composioConnections)
    .where(and(eq(composioConnections.projectId, projectId), eq(composioConnections.toolkitSlug, toolkitSlug)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listConnectionsByProject(projectId: string): Promise<ComposioConnection[]> {
  return db.select().from(composioConnections).where(eq(composioConnections.projectId, projectId));
}

/** Create or update the (project, toolkit) connection row. Only provided fields change on conflict. */
export async function upsertConnection(
  projectId: string,
  toolkitSlug: string,
  patch: { userId: string; connectedAccountId?: string | null; status?: string; linkUrl?: string | null; error?: string | null },
): Promise<ComposioConnection> {
  const rows = await db
    .insert(composioConnections)
    .values({ projectId, toolkitSlug, ...patch })
    .onConflictDoUpdate({
      target: [composioConnections.projectId, composioConnections.toolkitSlug],
      set: {
        connectedAccountId: patch.connectedAccountId,
        status: patch.status ?? 'initializing',
        linkUrl: patch.linkUrl,
        error: patch.error,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows[0];
}

export async function setConnectionStatus(
  id: string,
  status: string,
  error: string | null = null,
): Promise<ComposioConnection | null> {
  const rows = await db
    .update(composioConnections)
    .set({ status, error, updatedAt: new Date() })
    .where(eq(composioConnections.id, id))
    .returning();
  return rows[0] ?? null;
}
```

- [ ] **Step 2: Write the DB test**

`test/composio-store.test.ts`:
```ts
// ABOUTME: composio_store DB round-trips against real Neon — toolkit cache upsert, connection
// ABOUTME: upsert/list/status, and the (project_id, toolkit_slug) unique constraint. Self-cleaning.

import { describe, it, expect, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, composioConnections, composioToolkits } from '../lib/db/schema';
import { createProject } from '../lib/mutations';
import {
  getToolkitRow, upsertToolkitRow,
  getConnection, listConnectionsByProject, upsertConnection, setConnectionStatus,
} from '../lib/composio-store';

const projectIds: string[] = [];
const toolkitSlugs: string[] = [];
const tag = () => `vt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

afterEach(async () => {
  if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds)); // cascades connections
  if (toolkitSlugs.length) await db.delete(composioToolkits).where(inArray(composioToolkits.slug, toolkitSlugs));
  projectIds.length = 0;
  toolkitSlugs.length = 0;
});

async function freshProject() {
  const p = await createProject({ name: tag(), category: 'app', status: 'active' });
  projectIds.push(p.id);
  return p;
}

describe('composio store', () => {
  it('upserts the toolkit cache row (provided fields only)', async () => {
    const slug = `vt-${tag()}`;
    toolkitSlugs.push(slug);
    await upsertToolkitRow(slug, { authConfigId: 'ac_1' });
    await upsertToolkitRow(slug, { mcpServerId: 'srv_1', mcpUrl: 'https://x/v3/mcp/srv_1' });
    const row = await getToolkitRow(slug);
    expect(row?.authConfigId).toBe('ac_1');
    expect(row?.mcpServerId).toBe('srv_1');
    expect(row?.mcpUrl).toBe('https://x/v3/mcp/srv_1');
  });

  it('upserts a connection and enforces one row per (project, toolkit)', async () => {
    const p = await freshProject();
    const a = await upsertConnection(p.id, 'linear', { userId: `mc-proj-${p.id}`, status: 'initializing', connectedAccountId: 'ca_1' });
    const b = await upsertConnection(p.id, 'linear', { userId: `mc-proj-${p.id}`, status: 'active', connectedAccountId: 'ca_1' });
    expect(b.id).toBe(a.id); // same row (upsert, not a second insert)
    const list = await listConnectionsByProject(p.id);
    expect(list.length).toBe(1);
    expect(list[0].status).toBe('active');
  });

  it('setConnectionStatus updates status + error', async () => {
    const p = await freshProject();
    const c = await upsertConnection(p.id, 'slack', { userId: `mc-proj-${p.id}`, connectedAccountId: 'ca_2' });
    const updated = await setConnectionStatus(c.id, 'error', 'boom');
    expect(updated?.status).toBe('error');
    expect(updated?.error).toBe('boom');
  });

  it('getConnection returns null when absent', async () => {
    const p = await freshProject();
    expect(await getConnection(p.id, 'linear')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the DB test**

Run: `npx vitest run test/composio-store.test.ts`
Expected: PASS 4/4. (Hits real Neon; rows self-clean. Requires Task 1's migration applied.)

- [ ] **Step 4: Commit**

```bash
git add lib/composio-store.ts test/composio-store.test.ts
git commit -m "feat: composio store — DB CRUD for toolkits + connections"
```

---

### Task 3: API client (`lib/composio-api.ts`)

Composio v3 HTTP + pure helpers. No DB. Pure helpers are unit-tested; fetch wrappers are tested with a mocked global `fetch`.

**Files:**
- Create: `lib/composio-api.ts`
- Create: `test/composio-api.test.ts`

- [ ] **Step 1: Write the API client**

`lib/composio-api.ts`:
```ts
// ABOUTME: Composio v3 HTTP client (auth-config / MCP-server / connected-account) + pure helpers
// ABOUTME: (user_id derivation, status mapping, per-user MCP URL). No DB. Vercel-safe fetch, no SDK.

const COMPOSIO_BASE = 'https://backend.composio.dev/api/v3';

export class ComposioApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'ComposioApiError';
  }
}

/** Stable Composio user_id for a project (per-project connection isolation). */
export function deriveUserId(projectId: string): string {
  return `mc-proj-${projectId}`;
}

/** Per-user MCP URL = the toolkit's server base + ?user_id=. Placeholders never go in the URL. */
export function deriveMcpUrl(mcpUrlBase: string, userId: string): string {
  return `${mcpUrlBase}?user_id=${encodeURIComponent(userId)}`;
}

/** Map Composio's connected-account status to our lowercase enum. */
export function mapStatus(raw: string | undefined | null): string {
  switch ((raw ?? '').toUpperCase()) {
    case 'ACTIVE':
      return 'active';
    case 'INITIALIZING':
    case 'INITIATED':
      return 'initializing';
    case 'EXPIRED':
      return 'expired';
    case 'INACTIVE':
    case 'DISABLED':
      return 'disconnected';
    default:
      return 'error';
  }
}

async function composioFetch(path: string, init?: RequestInit): Promise<unknown> {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key) throw new ComposioApiError('COMPOSIO_API_KEY is not set');
  const res = await fetch(`${COMPOSIO_BASE}${path}`, {
    ...init,
    headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ComposioApiError(`Composio ${res.status}: ${body.slice(0, 300)}`, res.status);
  }
  return res.json();
}

/** Create a managed-OAuth auth config for a toolkit → its id. */
export async function createAuthConfig(toolkitSlug: string): Promise<string> {
  const j = (await composioFetch('/auth_configs', {
    method: 'POST',
    body: JSON.stringify({ toolkit: { slug: toolkitSlug }, auth_config: { type: 'use_composio_managed_auth', name: `mc-${toolkitSlug}` } }),
  })) as { auth_config?: { id?: string } };
  const id = j.auth_config?.id;
  if (!id) throw new ComposioApiError('auth config create returned no id');
  return id;
}

/** Create an MCP server bound to a toolkit's auth config + allow-list → { mcpServerId, mcpUrl }. */
export async function createMcpServer(
  toolkitSlug: string,
  authConfigId: string,
  allowedTools: string[],
): Promise<{ mcpServerId: string; mcpUrl: string }> {
  const j = (await composioFetch('/mcp/servers', {
    method: 'POST',
    body: JSON.stringify({ name: `mc-${toolkitSlug}`, auth_config_ids: [authConfigId], allowed_tools: allowedTools }),
  })) as { id?: string; mcp_url?: string };
  if (!j.id || !j.mcp_url) throw new ComposioApiError('mcp server create returned no id/url');
  return { mcpServerId: j.id, mcpUrl: j.mcp_url };
}

/** Begin a hosted-OAuth connection for a user → { redirectUrl, connectedAccountId }. */
export async function initiateConnection(
  authConfigId: string,
  userId: string,
): Promise<{ redirectUrl: string; connectedAccountId: string }> {
  const j = (await composioFetch('/connected_accounts/link', {
    method: 'POST',
    body: JSON.stringify({ auth_config_id: authConfigId, user_id: userId }),
  })) as { redirect_url?: string; connected_account_id?: string };
  if (!j.redirect_url || !j.connected_account_id) throw new ComposioApiError('link returned no redirect_url/connected_account_id');
  return { redirectUrl: j.redirect_url, connectedAccountId: j.connected_account_id };
}

/** Current Composio status for a connected account (raw, uppercase). */
export async function getConnectionStatus(connectedAccountId: string): Promise<string> {
  const j = (await composioFetch(`/connected_accounts/${connectedAccountId}`)) as { status?: string };
  return j.status ?? '';
}

export async function deleteConnection(connectedAccountId: string): Promise<void> {
  await composioFetch(`/connected_accounts/${connectedAccountId}`, { method: 'DELETE' });
}
```

- [ ] **Step 2: Write the API test (mocked fetch)**

`test/composio-api.test.ts`:
```ts
// ABOUTME: Composio API client — pure helpers (user_id, status map, MCP URL) + fetch-mocked wrappers.
// ABOUTME: No network: global fetch is stubbed per case. CI-safe.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  deriveUserId, deriveMcpUrl, mapStatus,
  createAuthConfig, createMcpServer, initiateConnection, getConnectionStatus,
  ComposioApiError,
} from '../lib/composio-api';

afterEach(() => vi.unstubAllGlobals());

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })));
}

describe('Composio API pure helpers', () => {
  it('derives a stable per-project user_id', () => {
    expect(deriveUserId('abc-123')).toBe('mc-proj-abc-123');
  });
  it('derives a per-user MCP URL', () => {
    expect(deriveMcpUrl('https://b/v3/mcp/srv1', 'mc-proj-x')).toBe('https://b/v3/mcp/srv1?user_id=mc-proj-x');
  });
  it('maps Composio statuses to our enum', () => {
    expect(mapStatus('ACTIVE')).toBe('active');
    expect(mapStatus('INITIALIZING')).toBe('initializing');
    expect(mapStatus('INITIATED')).toBe('initializing');
    expect(mapStatus('EXPIRED')).toBe('expired');
    expect(mapStatus('INACTIVE')).toBe('disconnected');
    expect(mapStatus('weird')).toBe('error');
  });
});

describe('Composio API wrappers (mocked fetch)', () => {
  it('createAuthConfig returns the new id', async () => {
    vi.stubEnv('COMPOSIO_API_KEY', 'ak_test');
    mockFetch(201, { auth_config: { id: 'ac_9' } });
    expect(await createAuthConfig('linear')).toBe('ac_9');
  });
  it('createMcpServer returns id + url', async () => {
    vi.stubEnv('COMPOSIO_API_KEY', 'ak_test');
    mockFetch(201, { id: 'srv_9', mcp_url: 'https://b/v3/mcp/srv_9' });
    expect(await createMcpServer('linear', 'ac_9', ['T'])).toEqual({ mcpServerId: 'srv_9', mcpUrl: 'https://b/v3/mcp/srv_9' });
  });
  it('initiateConnection returns redirect + connected account', async () => {
    vi.stubEnv('COMPOSIO_API_KEY', 'ak_test');
    mockFetch(201, { redirect_url: 'https://connect/x', connected_account_id: 'ca_9' });
    expect(await initiateConnection('ac_9', 'mc-proj-x')).toEqual({ redirectUrl: 'https://connect/x', connectedAccountId: 'ca_9' });
  });
  it('getConnectionStatus returns the raw status', async () => {
    vi.stubEnv('COMPOSIO_API_KEY', 'ak_test');
    mockFetch(200, { status: 'ACTIVE' });
    expect(await getConnectionStatus('ca_9')).toBe('ACTIVE');
  });
  it('throws ComposioApiError on a non-2xx', async () => {
    vi.stubEnv('COMPOSIO_API_KEY', 'ak_test');
    mockFetch(400, { error: 'bad' });
    await expect(getConnectionStatus('ca_9')).rejects.toBeInstanceOf(ComposioApiError);
  });
  it('throws when COMPOSIO_API_KEY is unset', async () => {
    vi.stubEnv('COMPOSIO_API_KEY', '');
    await expect(getConnectionStatus('ca_9')).rejects.toBeInstanceOf(ComposioApiError);
  });
});
```

- [ ] **Step 3: Run the API test**

Run: `npx vitest run test/composio-api.test.ts`
Expected: PASS. (No network — fetch is stubbed.)

- [ ] **Step 4: Commit**

```bash
git add lib/composio-api.ts test/composio-api.test.ts
git commit -m "feat: composio API client + pure helpers"
```

---

### Task 4: Orchestration (`lib/composio-connections.ts`)

Composes store + api into the lifecycle. Hits real Composio at runtime, so it's exercised live (Task 6), not unit-tested — keep it a thin composition with no logic worth mocking.

**Files:**
- Create: `lib/composio-connections.ts`

- [ ] **Step 1: Write the orchestration**

`lib/composio-connections.ts`:
```ts
// ABOUTME: Composio connection lifecycle — composes the DB store + the v3 API client into
// ABOUTME: ensureToolkit / connectStart / connectPoll / listConnections / disconnect. Per-project.

import { getCatalogEntry } from './composio-catalog';
import { getProjectBySlug } from './queries';
import { getToolkitRow, upsertToolkitRow, getConnection, listConnectionsByProject, upsertConnection, setConnectionStatus } from './composio-store';
import { createAuthConfig, createMcpServer, initiateConnection, getConnectionStatus, deleteConnection, deriveUserId, mapStatus } from './composio-api';
import type { ComposioConnection } from './db/schema';

export class ComposioConnectionError extends Error {}

/** Ensure the shared auth-config + MCP server exist for a toolkit; cache + return their ids. Idempotent
 *  via the composio_toolkits cache (created once per toolkit). */
export async function ensureToolkit(slug: string): Promise<{ authConfigId: string; mcpServerId: string; mcpUrl: string }> {
  const entry = getCatalogEntry(slug);
  if (!entry) throw new ComposioConnectionError(`unknown toolkit: ${slug}`);
  let row = await getToolkitRow(slug);
  if (!row?.authConfigId) {
    const authConfigId = await createAuthConfig(slug);
    row = await upsertToolkitRow(slug, { authConfigId });
  }
  if (!row.mcpServerId || !row.mcpUrl) {
    const { mcpServerId, mcpUrl } = await createMcpServer(slug, row.authConfigId!, entry.allowedTools);
    row = await upsertToolkitRow(slug, { mcpServerId, mcpUrl });
  }
  return { authConfigId: row.authConfigId!, mcpServerId: row.mcpServerId!, mcpUrl: row.mcpUrl! };
}

/** Begin connecting a project to a toolkit: ensure resources, start the hosted OAuth link, store the
 *  in-flight connection. Returns the link the operator opens to authorize. */
export async function connectStart(projectSlug: string, toolkitSlug: string): Promise<{ linkUrl: string; connection: ComposioConnection }> {
  const project = await getProjectBySlug(projectSlug);
  if (!project) throw new ComposioConnectionError(`unknown project: ${projectSlug}`);
  if (!getCatalogEntry(toolkitSlug)) throw new ComposioConnectionError(`unknown toolkit: ${toolkitSlug}`);
  const { authConfigId } = await ensureToolkit(toolkitSlug);
  const userId = deriveUserId(project.id);
  const { redirectUrl, connectedAccountId } = await initiateConnection(authConfigId, userId);
  const connection = await upsertConnection(project.id, toolkitSlug, {
    userId, connectedAccountId, status: 'initializing', linkUrl: redirectUrl, error: null,
  });
  return { linkUrl: redirectUrl, connection };
}

/** Poll Composio for the current status of a project's toolkit connection; persist + return it. */
export async function connectPoll(projectSlug: string, toolkitSlug: string): Promise<ComposioConnection> {
  const project = await getProjectBySlug(projectSlug);
  if (!project) throw new ComposioConnectionError(`unknown project: ${projectSlug}`);
  const conn = await getConnection(project.id, toolkitSlug);
  if (!conn?.connectedAccountId) throw new ComposioConnectionError(`no in-flight connection for ${projectSlug}/${toolkitSlug}`);
  const raw = await getConnectionStatus(conn.connectedAccountId);
  const updated = await setConnectionStatus(conn.id, mapStatus(raw));
  return updated ?? conn;
}

export async function listConnections(projectSlug: string): Promise<ComposioConnection[]> {
  const project = await getProjectBySlug(projectSlug);
  if (!project) throw new ComposioConnectionError(`unknown project: ${projectSlug}`);
  return listConnectionsByProject(project.id);
}

/** Revoke at Composio + mark the connection disconnected. */
export async function disconnect(projectSlug: string, toolkitSlug: string): Promise<ComposioConnection> {
  const project = await getProjectBySlug(projectSlug);
  if (!project) throw new ComposioConnectionError(`unknown project: ${projectSlug}`);
  const conn = await getConnection(project.id, toolkitSlug);
  if (!conn) throw new ComposioConnectionError(`no connection for ${projectSlug}/${toolkitSlug}`);
  if (conn.connectedAccountId) await deleteConnection(conn.connectedAccountId);
  const updated = await setConnectionStatus(conn.id, 'disconnected');
  return updated ?? conn;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. (Confirms the orchestration composes the real store/api/queries signatures — `getProjectBySlug`, the store fns, the api fns.)

- [ ] **Step 3: Commit**

```bash
git add lib/composio-connections.ts
git commit -m "feat: composio connection lifecycle orchestration"
```

---

### Task 5: `mc composio` CLI + spec sync

**Files:**
- Modify: `cli/index.ts` (command group + spec-registry entries)

- [ ] **Step 1: Add the command group**

In `cli/index.ts`, after the existing `integration` group (search for `const integration = program.command('integration')`), add:

```ts
const composio = program.command('composio').description('Manage project Composio connections (long-tail integrations)');

withFlags(composio.command('catalog'))
  .description('List supported Composio toolkits')
  .action((opts: LeafOpts) =>
    emit('composio catalog', opts, async () => {
      const { COMPOSIO_CATALOG } = await import('../lib/composio-catalog');
      const items = Object.entries(COMPOSIO_CATALOG).map(([slug, e]) => ({ slug, name: e.name, tools: e.allowedTools.length }));
      return { data: { items, count: items.length }, human: () => items.forEach((i) => console.log(`${i.slug}\t${i.name}\t(${i.tools} tools)`)) };
    }),
  );

withFlags(composio.command('connect'))
  .description('Begin connecting a project to a toolkit (prints the OAuth link to open)')
  .argument('<slug>')
  .argument('<toolkit>')
  .action((slug: string, toolkit: string, opts: LeafOpts) =>
    emit('composio connect', opts, async () => {
      const { connectStart } = await import('../lib/composio-connections');
      const { linkUrl, connection } = await connectStart(slug, toolkit);
      return { data: { linkUrl, connection }, human: () => console.log(`Open to authorize:\n${linkUrl}\nThen: mc composio status ${slug} ${toolkit}`) };
    }),
  );

withFlags(composio.command('status'))
  .description("Poll + print a connection's status")
  .argument('<slug>')
  .argument('<toolkit>')
  .action((slug: string, toolkit: string, opts: LeafOpts) =>
    emit('composio status', opts, async () => {
      const { connectPoll } = await import('../lib/composio-connections');
      const connection = await connectPoll(slug, toolkit);
      return { data: connection, human: () => console.log(`${slug}/${toolkit}: ${connection.status}`) };
    }),
  );

withFlags(composio.command('list'))
  .description("List a project's Composio connections")
  .argument('<slug>')
  .action((slug: string, opts: LeafOpts) =>
    emit('composio list', opts, async () => {
      const { listConnections } = await import('../lib/composio-connections');
      const items = await listConnections(slug);
      return { data: { items, count: items.length }, human: () => items.forEach((c) => console.log(`${c.toolkitSlug}\t${c.status}`)) };
    }),
  );

withFlags(composio.command('disconnect'))
  .description('Revoke + mark a connection disconnected')
  .argument('<slug>')
  .argument('<toolkit>')
  .action((slug: string, toolkit: string, opts: LeafOpts) =>
    emit('composio disconnect', opts, async () => {
      const { disconnect } = await import('../lib/composio-connections');
      const connection = await disconnect(slug, toolkit);
      return { data: connection, human: () => console.log(`${slug}/${toolkit}: ${connection.status}`) };
    }),
  );
```

(`import(...)` dynamic imports keep the DB/Composio modules out of the CLI's load path until a composio command actually runs — mirrors how other heavy commands lazy-load `loadDb()`. If the surrounding commands use a different lazy pattern, match it.)

- [ ] **Step 2: Add spec-registry entries**

Find the SPEC registry array in `cli/index.ts` (entries like `{ name: 'run start', readonly: false, summary: '…', required: [...], options: [...] }`). Add, alongside the others:

```ts
  { name: 'composio catalog', readonly: true, summary: 'List supported Composio toolkits', required: [], options: [] },
  { name: 'composio connect', readonly: false, summary: 'Begin connecting a project to a toolkit', required: [], options: [] },
  { name: 'composio status', readonly: false, summary: "Poll a connection's status", required: [], options: [] },
  { name: 'composio list', readonly: true, summary: "List a project's Composio connections", required: [], options: [] },
  { name: 'composio disconnect', readonly: false, summary: 'Revoke + mark a connection disconnected', required: [], options: [] },
```

(Match the exact field shape of the existing entries — if they omit `required`/`options` for arg-only commands, follow that. The goal: `test/spec-sync.test.ts` passes, which checks SPEC ↔ registered leaf commands.)

- [ ] **Step 3: Run the spec-sync + a CLI smoke**

Run: `npx vitest run test/spec-sync.test.ts`
Expected: PASS (SPEC ↔ leaf commands aligned).
Run: `MC_ENV_FILE="$PWD/.env.local" npx tsx cli/index.ts composio catalog --json`
Expected: `{"ok":true,...,"data":{"items":[{"slug":"linear",...},{"slug":"slack",...}],"count":2}}`.

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit` → clean.
Run: `npx eslint cli/index.ts lib/composio-*.ts` → clean.

- [ ] **Step 5: Commit**

```bash
git add cli/index.ts
git commit -m "feat: mc composio commands (catalog/connect/status/list/disconnect)"
```

---

### Task 6: Final gates + live exercise

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: all pass, including the three new test files (`composio-catalog`, `composio-api`, `composio-store`). Real Neon; new tests self-clean.

- [ ] **Step 2: Lint + typecheck the whole change**

Run: `npx eslint lib/composio-*.ts cli/index.ts test/composio-*.test.ts` → clean.
Run: `npx tsc --noEmit` → clean.

- [ ] **Step 3: Live exercise (manual — confirms the real loop)**

With a real `COMPOSIO_API_KEY` in `.env.local` and an existing project slug (pick one from `mc project list`):
```bash
mc composio connect <project-slug> linear   # prints an OAuth link
# open the link, authorize Linear
mc composio status <project-slug> linear     # → active
mc composio list <project-slug>              # shows linear: active
mc composio disconnect <project-slug> linear # → disconnected
```
Expected: `connect` prints a `connect.composio.dev/link/…` URL; after authorizing, `status` → `active`; `disconnect` → `disconnected`. (This mirrors the proof slice's manual flow, now per-project and stored.)

---

## Self-Review

**Spec coverage:**
- `composio_toolkits` + `composio_connections` tables, unique `(project_id, toolkit_slug)` → Task 1. ✓
- Static catalog (Linear + Slack allow-lists) → Task 1 (`lib/composio-catalog.ts`; Slack slugs filled from the tools API). ✓
- `lib/composio-api.ts` (ensure pieces: createAuthConfig/createMcpServer, initiate, status, delete) + pure helpers → Task 3. ✓
- `lib/composio-connections.ts` lifecycle (ensureToolkit/connectStart/connectPoll/list/disconnect) → Task 4. ✓
- `user_id = mc-proj-<projectId>`, derived MCP URL → Task 3 (`deriveUserId`, `deriveMcpUrl`). ✓
- `mc composio` commands → Task 5; spec-sync kept green. ✓
- Migration grants for `mc_agent`/`cc_agent` (`IF EXISTS`) → Task 1 Step 6. ✓
- Tests: CI-safe units (catalog, api) + DB (store) + live manual → Tasks 1–3, 6. ✓
- Secrets stay in env; rows hold only Composio ids → enforced by `lib/composio-api.ts` reading `process.env.COMPOSIO_API_KEY`; store rows carry only ids. ✓
- Out of scope (UI, auto-feed, old tab untouched) → nothing in the plan touches `IntegrationControl`/`app/p`. ✓

**Placeholder scan:** No TBD/TODO. The Slack allow-list is concrete (3 real slugs from the tools API). The drizzle migration filename is `00XX_<generated>` because drizzle assigns it — Task 1 Step 5 says to note the real name.

**Type consistency:** Store fns return `ComposioConnection`/`ComposioToolkit` (from schema `$inferSelect`); orchestration imports those + `getProjectBySlug` (existing, returns project with `.id`). `deriveUserId(project.id)`, `mapStatus(raw)`, `upsertConnection(projectId, slug, {userId,…})` signatures match across Tasks 2–4. CLI calls `connectStart/connectPoll/listConnections/disconnect` exactly as Task 4 exports them. ✓

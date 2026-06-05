# MCP Tab (slice 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the project "Integrations" tab into an "MCP" tab where a user can, in the browser, see every attached MCP server (Composio + remote), browse Composio's full live catalog and OAuth-connect any toolkit, and add a remote MCP server by URL + `${ENV}` headers.

**Architecture:** Pure surfacing slice — the spawn-feed (slice 3) is unchanged. The tab fetches the project's actual `mcp_connections` rows (both sources) for a unified "Connected" list, a new catalog endpoint backs in-browser discovery, and the existing project route gains `add-remote`/`remove-remote` POST actions. The connection lifecycle lib (`connectStart`/`disconnect`/`addRemote`/`removeRemote`/`listConnections`) and the catalog client (`listToolkits`) already exist — this slice wires them to UI.

**Tech Stack:** Next.js (App Router, server route handlers + `'use client'` tab components), React (fetch-in-effect + `useState`, no RTL harness), Vitest (node env — mocks the lib at the route layer), plain global CSS utility classes (`app/globals.css`), Drizzle/Neon (already migrated; **no migration in this slice**).

---

## Design decisions (read before starting)

1. **Discovery moves to a live catalog browser.** The old tab synthesized `not_connected` cards for the 2 curated toolkits (`toolkitViews`). That can't represent a non-curated toolkit connected via `mc mcp connect github`. So: the **Connected** section lists *actual rows only*; a new **Browse catalog** section (live `listToolkits`) is how you connect something new. `toolkitViews` + its test retire — replaced by `mcpServerViews`.
2. **Route path stays `/api/projects/[slug]/composio`.** Slice 1 deliberately left this internal route path unchanged (memory). We add a `catalog/` subroute and extend POST; we do **not** rename the folder.
3. **Component files rename to MCP.** This is the headline UI slice and the components are substantially rewritten, so `IntegrationsTab`→`McpTab`, `IntegrationRow`→`McpServerRow`. The lib file `composio-connections.ts` rename stays deferred (separate churn, per slice-3 deviation).
4. **Tab key `integrations`→`mcp`** with label `MCP`; add alias `{ integrations: 'mcp' }` so existing `?tab=integrations` deep links still resolve.
5. **No migration.** All columns exist from slice 3.

## File structure

- `lib/composio-view.ts` — **replace** `toolkitViews`/`ToolkitView` with `mcpServerViews`/`McpServerView` (unified, both sources, actual rows only).
- `app/api/projects/[slug]/composio/route.ts` — GET returns `{ servers }`; POST gains `add-remote`/`remove-remote`; per-action arg validation.
- `app/api/projects/[slug]/composio/catalog/route.ts` — **new** GET: live catalog + `featured`/`connected` flags.
- `components/McpServerRow.tsx` — **renamed** from `IntegrationRow.tsx`; one connected server (composio → Disconnect/Check status; remote → Remove).
- `components/McpCatalogBrowser.tsx` — **new**; search box + results + Connect.
- `components/McpRemoteForm.tsx` — **new**; name/url/header-rows + Add.
- `components/McpTab.tsx` — **renamed** from `IntegrationsTab.tsx`; container composing the three sections.
- `app/p/[slug]/page.tsx` — import + tab config + alias.
- `app/globals.css` — `mcp-*` section/catalog/remote/source classes.
- Tests: rewrite `test/composio-view.test.ts`; extend `test/composio-route.test.ts`; new `test/composio-catalog-route.test.ts`.
- Docs/memory: `AGENTS.md` (UI note), `project_mcp_unification.md`, `MEMORY.md`.

## Conventions (match these exactly)

- **Lint:** `npx eslint <changed files>` (NOT `npm run lint` — no-op). **Typecheck:** `npx tsc --noEmit` (4 pre-existing `WorkflowNode` errors in `test/workflow-runner.test.ts` are expected — ignore only those).
- **Tests:** `npx vitest run <file>`. Route tests **mock** `@/lib/authz` + `@/lib/composio-connections` (and `@/lib/composio-api` for catalog) — CI-safe, no DB/network. Mirror `test/composio-route.test.ts` exactly (import route AFTER `vi.mock`).
- **Components:** `'use client'`, ABOUTME header (2 lines), fetch in `useEffect` with a `loadSeq` guard for the container (copy `McpTab`'s idiom), raw `fetch` + `useState` for mutations (no server actions — repo has none for MCP). Global CSS classes only (no Tailwind/CSS-modules).
- **Commit** after each task (frequent commits).

---

### Task 1: Unified connection view model (`mcpServerViews`) + GET contract

**Files:**
- Modify: `lib/composio-view.ts` (replace whole file body)
- Modify: `app/api/projects/[slug]/composio/route.ts:6,49` (import + GET return)
- Test: `test/composio-view.test.ts` (rewrite), `test/composio-route.test.ts:43-55` (update GET test)

- [ ] **Step 1: Write the failing test** — rewrite `test/composio-view.test.ts`:

```ts
// ABOUTME: Unit tests for mcpServerViews — maps a project's mcp_connections rows (both sources) to
// ABOUTME: display views. Pure (no DB/network). Composio name falls back to slug; remotes carry url.
import { describe, it, expect } from 'vitest';
import { mcpServerViews } from '../lib/composio-view';
import type { McpConnection } from '../lib/db/schema';

function conn(partial: Partial<McpConnection>): McpConnection {
  return {
    id: 'id', projectId: 'p', source: 'composio', toolkitSlug: 'linear', userId: 'mc-proj-p',
    connectedAccountId: null, status: 'active', linkUrl: null, error: null,
    remoteName: null, remoteUrl: null, remoteHeaders: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...partial,
  } as McpConnection;
}

describe('mcpServerViews', () => {
  it('returns one view per connection row (composio + remote), no synthesized placeholders', () => {
    const views = mcpServerViews([
      conn({ toolkitSlug: 'linear', status: 'active' }),
      conn({ source: 'remote', toolkitSlug: null, userId: null, remoteName: 'docs', remoteUrl: 'https://r/mcp', status: 'active' }),
    ]);
    expect(views).toHaveLength(2);
    expect(views.map((v) => v.key).sort()).toEqual(['docs', 'linear']);
  });

  it('empty connections → empty list (no catalog placeholders)', () => {
    expect(mcpServerViews([])).toEqual([]);
  });

  it('composio view: known toolkit uses catalog name; unknown falls back to slug', () => {
    const [linear, gh] = mcpServerViews([
      conn({ toolkitSlug: 'linear' }),
      conn({ toolkitSlug: 'github' }),
    ]);
    expect(linear.source).toBe('composio');
    expect(linear.name).toBe('Linear');
    expect(gh.name).toBe('github'); // not in static catalog → slug
  });

  it('composio view exposes linkUrl ONLY while initializing', () => {
    const [init] = mcpServerViews([conn({ status: 'initializing', linkUrl: 'https://connect.composio.dev/link/x' })]);
    expect(init.linkUrl).toBe('https://connect.composio.dev/link/x');
    const [active] = mcpServerViews([conn({ status: 'active', linkUrl: 'https://connect.composio.dev/link/x' })]);
    expect(active.linkUrl).toBeNull();
  });

  it('remote view carries the url and never a linkUrl; passes error through', () => {
    const [v] = mcpServerViews([
      conn({ source: 'remote', toolkitSlug: null, userId: null, remoteName: 'docs', remoteUrl: 'https://r/mcp', status: 'active', error: 'boom' }),
    ]);
    expect(v.source).toBe('remote');
    expect(v.url).toBe('https://r/mcp');
    expect(v.linkUrl).toBeNull();
    expect(v.error).toBe('boom');
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run test/composio-view.test.ts` → FAIL (`mcpServerViews` not exported).

- [ ] **Step 3: Implement** — replace `lib/composio-view.ts` body:

```ts
// ABOUTME: Pure mapping of a project's mcp_connections rows (both sources) to display views for the
// ABOUTME: MCP tab's Connected section. One view per actual row — no catalog placeholders. No DB/network.

import type { McpConnection, ConnectionStatus } from './db/schema';
import { getCatalogEntry } from './composio-catalog';

export type McpServerStatus = ConnectionStatus; // every row has a real status (remote rows are pinned 'active')

export type McpServerView = {
  source: 'composio' | 'remote';
  key: string;        // toolkitSlug (composio) or remoteName (remote) — stable React key + POST identifier
  name: string;       // composio: catalog name or slug; remote: remoteName
  toolkitSlug: string | null;
  url: string | null;        // remote only
  status: McpServerStatus;
  linkUrl: string | null;    // composio, only while initializing
  error: string | null;
};

/** Map every connection row to a view. Composio rows resolve a display name from the static catalog,
 *  falling back to the raw slug (a toolkit connected via the CLI need not be curated). Remote rows
 *  carry their URL. No synthesized "not_connected" entries — discovery lives in the catalog browser. */
export function mcpServerViews(connections: McpConnection[]): McpServerView[] {
  return connections.map((c) => {
    if (c.source === 'remote') {
      return {
        source: 'remote', key: c.remoteName ?? c.id, name: c.remoteName ?? c.id,
        toolkitSlug: null, url: c.remoteUrl, status: c.status, linkUrl: null, error: c.error,
      };
    }
    const slug = c.toolkitSlug ?? c.id;
    return {
      source: 'composio', key: slug, name: getCatalogEntry(slug)?.name ?? slug,
      toolkitSlug: c.toolkitSlug, url: null, status: c.status,
      linkUrl: c.status === 'initializing' ? c.linkUrl : null, error: c.error,
    };
  });
}
```

  Then update the GET route — `app/api/projects/[slug]/composio/route.ts`:
  - Line 6 import: `import { mcpServerViews } from '@/lib/composio-view';`
  - Line 49 return: `return Response.json({ ok: true, data: { servers: mcpServerViews(connections) } });`

  And update `test/composio-route.test.ts` GET test (lines 44-55) to the new shape:

```ts
  it('returns the project mcp server views', async () => {
    lib.listConnections.mockResolvedValue([
      { source: 'composio', toolkitSlug: 'linear', remoteName: null, remoteUrl: null, status: 'active', linkUrl: null, error: null },
    ]);
    const res = await GET(new Request('http://localhost/api/projects/demo/composio'), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    const linear = json.data.servers.find((s: { key: string }) => s.key === 'linear');
    expect(linear.status).toBe('active');
    expect(linear.source).toBe('composio');
  });
```

- [ ] **Step 4: Run tests** — `npx vitest run test/composio-view.test.ts test/composio-route.test.ts` → PASS. Then `npx eslint lib/composio-view.ts app/api/projects/[slug]/composio/route.ts test/composio-view.test.ts test/composio-route.test.ts` → clean.

- [ ] **Step 5: Verify `toolkitViews` is fully retired** — `grep -rn "toolkitViews\|ToolkitView" app components lib test` must return **zero** matches. If anything remains, fix it.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(mcp): unified mcpServerViews + GET returns servers (slice 4)"`

---

### Task 2: Live catalog endpoint

**Files:**
- Create: `app/api/projects/[slug]/composio/catalog/route.ts`
- Test: `test/composio-catalog-route.test.ts`

- [ ] **Step 1: Write the failing test** — `test/composio-catalog-route.test.ts`:

```ts
// ABOUTME: Tests the MCP catalog browse endpoint — GET lists Composio's live catalog with featured +
// ABOUTME: connected flags. CI-safe: mocks the auth gate, listToolkits, and listConnections.
import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeUnauthorized extends Error {}
const requireAllowedUser = vi.fn(async () => ({ user: { email: 'joe@ticc.net' } }));
vi.mock('@/lib/authz', () => ({ requireAllowedUser: () => requireAllowedUser(), UnauthorizedError: FakeUnauthorized }));

const listToolkits = vi.fn();
vi.mock('@/lib/composio-api', () => ({ listToolkits: (o?: unknown) => listToolkits(o), ComposioApiError: class extends Error {} }));
const listConnections = vi.fn();
vi.mock('@/lib/composio-connections', () => ({ listConnections: (s: string) => listConnections(s) }));

const { GET } = await import('../app/api/projects/[slug]/composio/catalog/route');
const params = Promise.resolve({ slug: 'demo' });
function get(qs = '') { return GET(new Request(`http://localhost/api/projects/demo/composio/catalog${qs}`), { params }); }

beforeEach(() => {
  vi.clearAllMocks();
  requireAllowedUser.mockResolvedValue({ user: { email: 'joe@ticc.net' } });
  listConnections.mockResolvedValue([]);
});

describe('GET catalog', () => {
  it('returns toolkits with featured + connected flags', async () => {
    listToolkits.mockResolvedValue([
      { slug: 'linear', name: 'Linear', description: '', toolCount: 4, categories: [] },
      { slug: 'notion', name: 'Notion', description: '', toolCount: 9, categories: [] },
    ]);
    listConnections.mockResolvedValue([{ source: 'composio', toolkitSlug: 'linear', status: 'active' }]);
    const res = await get('?search=l');
    expect(res.status).toBe(200);
    const json = await res.json();
    const linear = json.data.toolkits.find((t: { slug: string }) => t.slug === 'linear');
    const notion = json.data.toolkits.find((t: { slug: string }) => t.slug === 'notion');
    expect(linear.featured).toBe(true);   // in COMPOSIO_CATALOG
    expect(linear.connected).toBe(true);  // has an active composio row
    expect(notion.featured).toBe(false);
    expect(notion.connected).toBe(false);
    expect(listToolkits).toHaveBeenCalledWith({ search: 'l', limit: undefined });
  });

  it('passes a numeric limit through; ignores a non-numeric one', async () => {
    listToolkits.mockResolvedValue([]);
    await get('?limit=20');
    expect(listToolkits).toHaveBeenCalledWith({ search: undefined, limit: 20 });
    await get('?limit=abc');
    expect(listToolkits).toHaveBeenLastCalledWith({ search: undefined, limit: undefined });
  });

  it('401 when the auth gate rejects', async () => {
    requireAllowedUser.mockRejectedValue(new FakeUnauthorized());
    expect((await get()).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run test/composio-catalog-route.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `app/api/projects/[slug]/composio/catalog/route.ts`:

```ts
// ABOUTME: MCP catalog browse for a project — GET lists Composio's live toolkit catalog (search/limit)
// ABOUTME: with featured (curated) + connected (this project already has an active row) flags.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { listToolkits, ComposioApiError } from '@/lib/composio-api';
import { listConnections } from '@/lib/composio-connections';
import { COMPOSIO_CATALOG } from '@/lib/composio-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    await requireAllowedUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    throw e;
  }
  const { slug } = await params;
  const url = new URL(req.url);
  const search = url.searchParams.get('search') || undefined;
  const limitRaw = url.searchParams.get('limit');
  const limitNum = limitRaw !== null ? Number(limitRaw) : NaN;
  const limit = Number.isFinite(limitNum) && limitNum > 0 ? limitNum : undefined;
  try {
    const [toolkits, connections] = await Promise.all([listToolkits({ search, limit }), listConnections(slug)]);
    const connected = new Set(
      connections.filter((c) => c.source === 'composio' && c.status === 'active' && c.toolkitSlug).map((c) => c.toolkitSlug),
    );
    return Response.json({
      ok: true,
      data: {
        toolkits: toolkits.map((t) => ({ ...t, featured: t.slug in COMPOSIO_CATALOG, connected: connected.has(t.slug) })),
      },
    });
  } catch (e) {
    if (e instanceof ComposioApiError) {
      return Response.json({ ok: false, error: 'composio_api_error', message: e.message }, { status: e.status ?? 502 });
    }
    throw e;
  }
}
```

- [ ] **Step 4: Run tests** — `npx vitest run test/composio-catalog-route.test.ts` → PASS. `npx eslint "app/api/projects/[slug]/composio/catalog/route.ts" test/composio-catalog-route.test.ts` → clean.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(mcp): live catalog browse endpoint (slice 4)"`

---

### Task 3: `add-remote` / `remove-remote` POST actions

**Files:**
- Modify: `app/api/projects/[slug]/composio/route.ts` (imports + POST switch + per-action validation)
- Test: `test/composio-route.test.ts` (extend the lib mock + add cases)

- [ ] **Step 1: Write the failing test** — in `test/composio-route.test.ts`, add `addRemote`/`removeRemote` to the lib mock (line 17-22) and add cases:

```ts
// add to the `lib` object: addRemote: vi.fn(), removeRemote: vi.fn(),

describe('POST remote actions', () => {
  it('add-remote → returns the new remote view fields', async () => {
    lib.addRemote.mockResolvedValue({ source: 'remote', remoteName: 'docs', remoteUrl: 'https://r/mcp', status: 'active' });
    const res = await post({ action: 'add-remote', name: 'docs', url: 'https://r/mcp', headers: { Authorization: 'Bearer ${TOK}' } });
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe('active');
    expect(lib.addRemote).toHaveBeenCalledWith('demo', { name: 'docs', url: 'https://r/mcp', headers: { Authorization: 'Bearer ${TOK}' } });
  });

  it('add-remote with no headers defaults to {}', async () => {
    lib.addRemote.mockResolvedValue({ status: 'active' });
    await post({ action: 'add-remote', name: 'docs', url: 'https://r/mcp' });
    expect(lib.addRemote).toHaveBeenCalledWith('demo', { name: 'docs', url: 'https://r/mcp', headers: {} });
  });

  it('add-remote → 422 when name or url missing', async () => {
    expect((await post({ action: 'add-remote', url: 'https://r/mcp' })).status).toBe(422);
    expect((await post({ action: 'add-remote', name: 'docs' })).status).toBe(422);
    expect(lib.addRemote).not.toHaveBeenCalled();
  });

  it('add-remote → 422 when validateRemoteInput throws (literal secret)', async () => {
    lib.addRemote.mockRejectedValue(new ValidationError('headers', 'header value must be a ${ENV} placeholder'));
    expect((await post({ action: 'add-remote', name: 'docs', url: 'https://r/mcp', headers: { Authorization: 'secret' } })).status).toBe(422);
  });

  it('remove-remote → returns ok', async () => {
    lib.removeRemote.mockResolvedValue({ source: 'remote', remoteName: 'docs', status: 'disconnected' });
    const res = await post({ action: 'remove-remote', name: 'docs' });
    expect(res.status).toBe(200);
    expect(lib.removeRemote).toHaveBeenCalledWith('demo', 'docs');
  });

  it('remove-remote → 422 when name missing', async () => {
    expect((await post({ action: 'remove-remote' })).status).toBe(422);
  });

  it('remove-remote → 404 when no such remote', async () => {
    lib.removeRemote.mockRejectedValue(new NotFoundError('remote connection', 'demo/docs'));
    expect((await post({ action: 'remove-remote', name: 'docs' })).status).toBe(404);
  });
});
```

  Note the existing "422 on missing toolkit" test (line 97-100) uses `{ action: 'connect' }` — keep it; connect still requires `toolkit`.

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run test/composio-route.test.ts` → new cases FAIL.

- [ ] **Step 3: Implement** — edit `app/api/projects/[slug]/composio/route.ts`:
  - Line 5 import: add `addRemote, removeRemote` →
    `import { listConnections, connectStart, connectPoll, disconnect, addRemote, removeRemote } from '@/lib/composio-connections';`
  - Replace the `PostBody` type + the `toolkit` guard + switch. The toolkit-required guard must be **per-action** (connect/status/disconnect need `toolkit`; remote actions need `name`):

```ts
type PostBody = { action?: string; toolkit?: string; name?: string; url?: string; headers?: Record<string, string> };

// ... after parsing body, REMOVE the unconditional `if (!toolkit)` guard. Then:
  const { action } = body;
  try {
    switch (action) {
      case 'connect':
      case 'status':
      case 'disconnect': {
        if (!body.toolkit) {
          return Response.json({ ok: false, error: 'validation', message: 'toolkit required' }, { status: 422 });
        }
        if (action === 'connect') {
          const { linkUrl, connection } = await connectStart(slug, body.toolkit);
          return Response.json({ ok: true, data: { linkUrl, status: connection.status } });
        }
        if (action === 'status') {
          const connection = await connectPoll(slug, body.toolkit);
          return Response.json({ ok: true, data: { status: connection.status } });
        }
        const connection = await disconnect(slug, body.toolkit);
        return Response.json({ ok: true, data: { status: connection.status } });
      }
      case 'add-remote': {
        if (!body.name || !body.url) {
          return Response.json({ ok: false, error: 'validation', message: 'name and url required' }, { status: 422 });
        }
        const connection = await addRemote(slug, { name: body.name, url: body.url, headers: body.headers ?? {} });
        return Response.json({ ok: true, data: { status: connection.status } });
      }
      case 'remove-remote': {
        if (!body.name) {
          return Response.json({ ok: false, error: 'validation', message: 'name required' }, { status: 422 });
        }
        const connection = await removeRemote(slug, body.name);
        return Response.json({ ok: true, data: { status: connection.status } });
      }
      default:
        return Response.json(
          { ok: false, error: 'validation', message: `unknown action: ${String(action)}` },
          { status: 422 },
        );
    }
  } catch (e) {
    return mapError(e);
  }
```

- [ ] **Step 4: Run tests** — `npx vitest run test/composio-route.test.ts` → PASS (all old + new). `npx eslint "app/api/projects/[slug]/composio/route.ts" test/composio-route.test.ts` → clean.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(mcp): add-remote/remove-remote POST actions (slice 4)"`

---

### Task 4: `McpServerRow` component (rename + generalize for both sources)

**Files:**
- Create: `components/McpServerRow.tsx` (rename of `IntegrationRow.tsx`)
- Delete: `components/IntegrationRow.tsx`

No unit test (node-env vitest, no RTL). Verify via tsc + eslint; behavior verified in the Task 9 live smoke.

- [ ] **Step 1: Create `components/McpServerRow.tsx`**:

```tsx
'use client';

// ABOUTME: One connected MCP server row — composio (Disconnect / Check status / open link) or remote
// ABOUTME: (Remove). Posts to /api/projects/[slug]/composio; opens the Composio hosted link on connect.

import { useState } from 'react';
import type { McpServerView, McpServerStatus } from '@/lib/composio-view';

const PILL: Record<McpServerStatus, { cls: string; label: string }> = {
  active: { cls: 'pill ok', label: 'Active' },
  initializing: { cls: 'pill warn', label: 'Initializing' },
  error: { cls: 'pill bad', label: 'Error' },
  expired: { cls: 'pill bad', label: 'Expired' },
  disconnected: { cls: 'pill', label: 'Off' },
};

type PostResult =
  | { ok: true; data: { linkUrl?: string; status?: string } }
  | { ok: false; error: string; message?: string };

export function McpServerRow({
  slug,
  view,
  onChanged,
}: {
  slug: string;
  view: McpServerView;
  onChanged: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  async function run(body: Record<string, unknown>, opensLink = false) {
    setPending(true);
    setRowError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/composio`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as PostResult;
      if (!json.ok) {
        setRowError(json.message ?? json.error ?? 'Request failed');
        return;
      }
      if (opensLink && json.data.linkUrl) window.open(json.data.linkUrl, '_blank', 'noopener,noreferrer');
      await onChanged();
    } catch (err) {
      setRowError(String(err));
    } finally {
      setPending(false);
    }
  }

  const pill = PILL[view.status];
  const isRemote = view.source === 'remote';
  const initializing = view.status === 'initializing';

  return (
    <div className="intg-control">
      <span className="intg-control-label">
        <span className="mcp-source-tag">{isRemote ? 'Remote' : 'Composio'}</span>
        {view.name}
        {view.url && <span className="intg-tools"> · {view.url}</span>}
        {initializing && view.linkUrl && (
          <>
            {' · '}
            <a className="detail-link" href={view.linkUrl} target="_blank" rel="noreferrer">open link ↗</a>
          </>
        )}
        {rowError && <span className="intg-error"> · {rowError}</span>}
      </span>
      <span className="intg-actions">
        <span className={pill.cls}>{pill.label}</span>
        {isRemote ? (
          <button type="button" className="btn-sm btn-bad" disabled={pending} onClick={() => void run({ action: 'remove-remote', name: view.key })}>
            Remove
          </button>
        ) : initializing ? (
          <button type="button" className="btn-sm" disabled={pending} onClick={() => void run({ action: 'status', toolkit: view.key })}>
            Check status
          </button>
        ) : (
          <button type="button" className="btn-sm btn-bad" disabled={pending} onClick={() => void run({ action: 'disconnect', toolkit: view.key })}>
            Disconnect
          </button>
        )}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Delete the old file** — `git rm components/IntegrationRow.tsx`

- [ ] **Step 3: Verify** — `npx tsc --noEmit 2>&1 | grep -i integrationrow` returns nothing; `npx eslint components/McpServerRow.tsx` → clean. (Container import is fixed in Task 7; a transient tsc error about the missing import in `IntegrationsTab.tsx` is expected until then — note it, don't fix here.)

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(mcp): McpServerRow (both sources) replaces IntegrationRow (slice 4)"`

---

### Task 5: `McpCatalogBrowser` component

**Files:**
- Create: `components/McpCatalogBrowser.tsx`

- [ ] **Step 1: Create `components/McpCatalogBrowser.tsx`**:

```tsx
'use client';

// ABOUTME: Browse Composio's live catalog inside the MCP tab — search box + results; Connect opens the
// ABOUTME: hosted OAuth link. Featured (curated) toolkits show by default; already-connected ones are tagged.

import { useState, useEffect, useRef } from 'react';

type CatalogItem = { slug: string; name: string; description: string; toolCount: number; featured: boolean; connected: boolean };
type CatalogResponse = { ok: boolean; error?: string; message?: string; data?: { toolkits: CatalogItem[] } };

export function McpCatalogBrowser({ slug, onConnected }: { slug: string; onConnected: () => void | Promise<void> }) {
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const loadSeq = useRef(0);

  useEffect(() => {
    const seq = ++loadSeq.current;
    setLoading(true);
    const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
    const t = setTimeout(() => {
      fetch(`/api/projects/${slug}/composio/catalog${qs}`)
        .then((res) => res.json())
        .then((json: CatalogResponse) => {
          if (seq !== loadSeq.current) return;
          if (json.ok && json.data) { setItems(json.data.toolkits); setError(null); }
          else setError(json.message ?? json.error ?? 'Failed to load catalog');
        })
        .catch((err: unknown) => { if (seq === loadSeq.current) setError(String(err)); })
        .finally(() => { if (seq === loadSeq.current) setLoading(false); });
    }, 250); // debounce typing
    return () => clearTimeout(t);
  }, [slug, search]);

  async function connect(toolkit: string) {
    setBusy(toolkit);
    try {
      const res = await fetch(`/api/projects/${slug}/composio`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'connect', toolkit }),
      });
      const json = (await res.json()) as { ok: boolean; data?: { linkUrl?: string }; message?: string; error?: string };
      if (json.ok && json.data?.linkUrl) window.open(json.data.linkUrl, '_blank', 'noopener,noreferrer');
      else if (!json.ok) setError(json.message ?? json.error ?? 'Connect failed');
      await onConnected();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mcp-catalog">
      <input
        className="mcp-search"
        type="search"
        placeholder="Search Composio catalog…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search Composio catalog"
      />
      {error && <p className="intg-error">{error}</p>}
      {loading && items.length === 0 ? (
        <p className="detail-muted">Loading…</p>
      ) : (
        <ul className="mcp-catalog-list">
          {items.map((t) => (
            <li key={t.slug} className="mcp-catalog-item">
              <span className="intg-control-label">
                {t.name}
                {t.featured && <span className="mcp-source-tag"> Featured</span>}
                <span className="intg-tools"> · {t.toolCount} tools</span>
              </span>
              {t.connected ? (
                <span className="pill ok">Connected</span>
              ) : (
                <button type="button" className="btn-sm btn-ok" disabled={busy === t.slug} onClick={() => void connect(t.slug)}>
                  Connect
                </button>
              )}
            </li>
          ))}
          {!loading && items.length === 0 && <li className="detail-muted">No toolkits found.</li>}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify** — `npx eslint components/McpCatalogBrowser.tsx` → clean; `npx tsc --noEmit 2>&1 | grep -i mcpcatalogbrowser` returns nothing.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat(mcp): catalog browser component (slice 4)"`

---

### Task 6: `McpRemoteForm` component

**Files:**
- Create: `components/McpRemoteForm.tsx`

- [ ] **Step 1: Create `components/McpRemoteForm.tsx`**:

```tsx
'use client';

// ABOUTME: Add a remote MCP server from the MCP tab — name + URL + repeatable header rows. Header values
// ABOUTME: must be ${ENV} placeholders (server validates; secrets never reach the DB). Posts add-remote.

import { useState } from 'react';

type HeaderRow = { key: string; value: string };

export function McpRemoteForm({ slug, onAdded }: { slug: string; onAdded: () => void | Promise<void> }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<HeaderRow[]>([{ key: '', value: '' }]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setHeader(i: number, patch: Partial<HeaderRow>) {
    setHeaders((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const headerMap: Record<string, string> = {};
      for (const { key, value } of headers) if (key.trim()) headerMap[key.trim()] = value;
      const res = await fetch(`/api/projects/${slug}/composio`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'add-remote', name: name.trim(), url: url.trim(), headers: headerMap }),
      });
      const json = (await res.json()) as { ok: boolean; message?: string; error?: string };
      if (!json.ok) { setError(json.message ?? json.error ?? 'Add failed'); return; }
      setName(''); setUrl(''); setHeaders([{ key: '', value: '' }]);
      await onAdded();
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="mcp-remote-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <input className="mcp-input" placeholder="Name (e.g. docs)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Remote server name" />
      <input className="mcp-input" placeholder="https://server/mcp" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Remote server URL" />
      {headers.map((h, i) => (
        <div className="mcp-header-row" key={i}>
          <input className="mcp-input" placeholder="Header (e.g. Authorization)" value={h.key} onChange={(e) => setHeader(i, { key: e.target.value })} aria-label="Header name" />
          <input className="mcp-input" placeholder="Bearer ${ENV_VAR}" value={h.value} onChange={(e) => setHeader(i, { value: e.target.value })} aria-label="Header value" />
          {i === headers.length - 1 && (
            <button type="button" className="btn-sm" onClick={() => setHeaders((r) => [...r, { key: '', value: '' }])}>+ header</button>
          )}
        </div>
      ))}
      <p className="detail-muted mcp-hint">Header values must be <code>${'{ENV_VAR}'}</code> placeholders — resolved at spawn, never stored.</p>
      {error && <p className="intg-error">{error}</p>}
      <button type="submit" className="btn-sm btn-ok" disabled={pending || !name.trim() || !url.trim()}>Add remote server</button>
    </form>
  );
}
```

- [ ] **Step 2: Verify** — `npx eslint components/McpRemoteForm.tsx` → clean; `npx tsc --noEmit 2>&1 | grep -i mcpremoteform` returns nothing.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat(mcp): add-remote form component (slice 4)"`

---

### Task 7: `McpTab` container (rename + compose three sections)

**Files:**
- Create: `components/McpTab.tsx` (rename of `IntegrationsTab.tsx`)
- Delete: `components/IntegrationsTab.tsx`

- [ ] **Step 1: Create `components/McpTab.tsx`** (keeps the `loadSeq`/focus-poll idiom; renders Connected + Browse + Add Remote):

```tsx
'use client';

// ABOUTME: MCP tab container — lists the project's attached MCP servers (composio + remote), a live
// ABOUTME: catalog browser to connect any toolkit, and a form to add a remote server. Re-polls
// ABOUTME: initializing connections on window focus (returning from OAuth).

import { useState, useEffect, useCallback, useRef } from 'react';
import type { McpServerView } from '@/lib/composio-view';
import { McpServerRow } from './McpServerRow';
import { McpCatalogBrowser } from './McpCatalogBrowser';
import { McpRemoteForm } from './McpRemoteForm';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; servers: McpServerView[] };

type GetResponse = { ok: boolean; error?: string; message?: string; data?: { servers: McpServerView[] } };

function toState(json: GetResponse): State {
  if (json.ok && json.data) return { kind: 'data', servers: json.data.servers };
  return { kind: 'error', message: json.message ?? json.error ?? 'Failed to load MCP servers' };
}

export function McpTab({ slug }: { slug: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const stateRef = useRef<State>(state);
  const loadSeq = useRef(0);

  useEffect(() => { stateRef.current = state; });

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await fetch(`/api/projects/${slug}/composio`);
      const json = (await res.json()) as GetResponse;
      if (seq === loadSeq.current) setState(toState(json));
    } catch (err) {
      if (seq === loadSeq.current) setState({ kind: 'error', message: String(err) });
    }
  }, [slug]);

  useEffect(() => {
    const seq = ++loadSeq.current;
    fetch(`/api/projects/${slug}/composio`)
      .then((res) => res.json())
      .then((json: GetResponse) => { if (seq === loadSeq.current) setState(toState(json)); })
      .catch((err: unknown) => { if (seq === loadSeq.current) setState({ kind: 'error', message: String(err) }); });
  }, [slug]);

  useEffect(() => {
    async function onFocus() {
      const s = stateRef.current;
      if (s.kind !== 'data') return;
      const initializing = s.servers.filter((t) => t.source === 'composio' && t.status === 'initializing');
      if (initializing.length === 0) return;
      await Promise.all(
        initializing.map((t) =>
          fetch(`/api/projects/${slug}/composio`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'status', toolkit: t.key }),
          }).catch(() => undefined),
        ),
      );
      await load();
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [slug, load]);

  return (
    <div className="detail-mcp">
      <section className="mcp-section">
        <h3 className="mcp-section-title">Connected</h3>
        {state.kind === 'loading' && (
          <div className="detail-integrations skeleton" aria-label="Loading MCP servers">
            <div className="skeleton-bar" /><div className="skeleton-bar" />
          </div>
        )}
        {state.kind === 'error' && (
          <div className="detail-integrations">
            <p className="detail-muted">Failed to load MCP servers: {state.message}</p>
            <button type="button" className="btn-sm" onClick={() => { setState({ kind: 'loading' }); void load(); }}>Retry</button>
          </div>
        )}
        {state.kind === 'data' && (
          <div className="detail-integrations">
            {state.servers.length === 0 && <p className="detail-muted">No MCP servers connected yet.</p>}
            {state.servers.map((t) => <McpServerRow key={`${t.source}:${t.key}`} slug={slug} view={t} onChanged={load} />)}
          </div>
        )}
      </section>

      <section className="mcp-section">
        <h3 className="mcp-section-title">Browse catalog</h3>
        <McpCatalogBrowser slug={slug} onConnected={load} />
      </section>

      <section className="mcp-section">
        <h3 className="mcp-section-title">Add remote server</h3>
        <McpRemoteForm slug={slug} onAdded={load} />
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Delete the old file** — `git rm components/IntegrationsTab.tsx`

- [ ] **Step 3: Verify** — `npx tsc --noEmit 2>&1 | grep -iE "integrationstab|mcptab|mcpserverrow"` returns nothing (page.tsx still imports the old name → that breaks tsc until Task 8; scope this grep to the component files only, or accept the single page.tsx error here and clear it in Task 8). `npx eslint components/McpTab.tsx` → clean.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(mcp): McpTab container with Connected/Browse/Remote sections (slice 4)"`

---

### Task 8: Wire the tab into the page (rename key/label + alias) + CSS

**Files:**
- Modify: `app/p/[slug]/page.tsx:1,20,112,165,170`
- Modify: `app/globals.css` (append `mcp-*` classes)
- Modify: `components/workflows/WorkflowsTab.tsx:6,56` (comment refs `IntegrationsTab` → `McpTab`)

- [ ] **Step 1: Edit `app/p/[slug]/page.tsx`**:
  - Line 1 ABOUTME: `…tabs for overview/tasks/mcp/activity.`
  - Line 20 import: `import { McpTab } from '@/components/McpTab';`
  - Line 112: `const integrationsPanel = <McpTab slug={project.slug} />;` → rename var to `mcpPanel`: `const mcpPanel = <McpTab slug={project.slug} />;`
  - Line 165 alias: `aliases={{ board: 'tasks', integrations: 'mcp' }}`
  - Line 170 tab config: `{ key: 'mcp', label: 'MCP', content: mcpPanel },`

- [ ] **Step 2: Append CSS to `app/globals.css`** (near the existing `.detail-integrations` block ~line 1176):

```css
/* MCP tab (slice 4) */
.detail-mcp { display: flex; flex-direction: column; gap: var(--space-lg); }
.mcp-section { display: flex; flex-direction: column; gap: var(--space-xs); }
.mcp-section-title { font-size: var(--fs-12); font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-mute); margin: 0; }
.mcp-source-tag { font-size: var(--fs-11); font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: var(--ink-mute); margin-right: 8px; }
.mcp-catalog { display: flex; flex-direction: column; gap: var(--space-xs); }
.mcp-search, .mcp-input { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); color: var(--ink); }
.mcp-catalog-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2xs); max-height: 320px; overflow-y: auto; }
.mcp-catalog-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; }
.mcp-remote-form { display: flex; flex-direction: column; gap: var(--space-2xs); align-items: flex-start; }
.mcp-header-row { display: flex; gap: 8px; width: 100%; }
.mcp-hint { font-size: var(--fs-12); }
```

  **First confirm the CSS variable names exist** (`--line`, `--surface`, `--radius-sm`, `--space-lg`, `--space-2xs`, `--fs-11`, `--fs-12`): `grep -nE "\-\-(line|surface|radius-sm|space-lg|space-2xs|fs-11|fs-12)\b" app/globals.css`. If any is missing, substitute the closest existing token (e.g. reuse `--space-sm`, `--fs-14`, `--border`) — do not invent variables.

- [ ] **Step 3: Update WorkflowsTab comment refs** — `components/workflows/WorkflowsTab.tsx` lines 6 + 56: change `IntegrationsTab` → `McpTab` in the two comments.

- [ ] **Step 4: Full typecheck + lint** — `npx tsc --noEmit` → only the 4 pre-existing `test/workflow-runner.test.ts` `WorkflowNode` errors remain (zero `integration`/`mcp` errors). `npx eslint "app/p/[slug]/page.tsx" app/globals.css components/workflows/WorkflowsTab.tsx` → clean (note: eslint may skip `.css`; that's fine).

- [ ] **Step 5: Confirm no dangling references** — `grep -rn "IntegrationsTab\|IntegrationRow" app components` → zero matches.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(mcp): rename Integrations tab → MCP (key/label/alias) + styles (slice 4)"`

---

### Task 9: Docs, full test run, live smoke, memory

**Files:**
- Modify: `AGENTS.md` (note the MCP tab UI is the in-browser path)
- Modify: memory `project_mcp_unification.md`, `MEMORY.md`

- [ ] **Step 1: Full test suite** — `npx vitest run`. Expect the slice-touched files green. (Known: the real-Neon suite can throw transient `ECONNRESET`/`fetch failed` under load — those are infra flakes, not regressions; re-run any failed file in isolation to confirm. The new/edited files in this slice — `composio-view`, `composio-route`, `composio-catalog-route` — are mocked and must be deterministically green.)

- [ ] **Step 2: Live browser smoke** (dev server + `/browse`): `npm run dev`, open a project's MCP tab. Verify:
  - Tab label reads **MCP**; `?tab=integrations` still lands on it (alias).
  - **Connected** shows existing rows source-tagged (the slice-3 smoke left a remote on a project; if none, the empty-state copy shows).
  - **Browse catalog**: typing filters; Featured tagged; an already-connected toolkit shows "Connected".
  - **Add remote**: a literal-secret header value surfaces the validation error (422) inline; a `${ENV}` value succeeds and the row appears in Connected after refresh.
  - Remove a remote → row disappears.

- [ ] **Step 3: AGENTS.md** — add a one-line note under the `mc mcp` section that the project's **MCP tab** is the in-browser equivalent (browse catalog + connect + add-remote), so connecting no longer requires the CLI.

- [ ] **Step 4: Final code review** — dispatch `feature-dev:code-reviewer` over the whole branch diff (`git diff main...HEAD`). Address any high-confidence issues.

- [ ] **Step 5: Update memory** — mark slice 4 SHIPPED in `project_mcp_unification.md` + the `MEMORY.md` index line (PR # + squash sha after merge).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "docs(mcp): MCP tab UI note + slice 4 wrap-up"`

---

## Self-review (done at authoring)

- **Spec coverage:** (1) connect any toolkit → Task 2 catalog endpoint + Task 5 browser; (2) add any remote → Task 3 actions + Task 6 form; (3) tab → MCP → Task 1/7/8. ✓
- **Type consistency:** `McpServerView`/`McpServerStatus` defined in Task 1, consumed in Tasks 4 + 7; `key` is the POST identifier (`toolkit` for composio, `name` for remote) — matched in McpServerRow + route. ✓
- **No migration:** all columns exist (slice 3). ✓
- **Retirement:** `toolkitViews`/`ToolkitView`/`IntegrationRow`/`IntegrationsTab` all removed; grep guards in Tasks 1, 4, 8. ✓
- **Test strategy:** lib + routes TDD (mocked, CI-safe); components verified by tsc/eslint + live smoke (no RTL harness in repo). ✓

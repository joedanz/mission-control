# Composio Integrations Tab UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the project detail page's old manual tri-state Integrations tab with a live Composio toolkit catalog (Connect / status / Disconnect) driven by the slice-2 `mc composio` connection lifecycle.

**Architecture:** A pure merge function (`lib/composio-view.ts`) overlays each project's stored connections onto the static catalog; one GET+POST API route (`app/api/projects/[slug]/composio/route.ts`) exposes the merged view and the connect/status/disconnect actions over the existing lifecycle functions; two client components (`IntegrationsTab` container + `IntegrationRow`) render a row list, open the Composio hosted link on Connect, and re-poll on window focus. The detail page swaps its server-rendered panel for `<IntegrationsTab>`.

**Tech Stack:** Next.js 16 App Router (route handlers + client components), TypeScript, Vitest (node env, real Neon for DB suites; this slice's new tests are CI-safe with mocks), vanilla CSS tokens.

---

## Context the implementer needs

- **Slice-2 lifecycle** (`lib/composio-connections.ts`, already merged) exports:
  - `connectStart(projectSlug, toolkitSlug): Promise<{ linkUrl: string; connection: ComposioConnection }>`
  - `connectPoll(projectSlug, toolkitSlug): Promise<ComposioConnection>`
  - `listConnections(projectSlug): Promise<ComposioConnection[]>`
  - `disconnect(projectSlug, toolkitSlug): Promise<ComposioConnection>`
  - These throw `NotFoundError` / `ValidationError` (from `lib/validation.ts`) and `ComposioApiError` (from `lib/composio-api.ts`, has a `status?: number`).
- **Catalog** (`lib/composio-catalog.ts`) exports `COMPOSIO_CATALOG: Record<string, { name: string; allowedTools: string[] }>`, `getCatalogEntry(slug)`, `catalogSlugs(): string[]`. Seeded: `linear` (4 tools), `slack` (3 tools).
- **`ComposioConnection`** (from `lib/db/schema.ts`) fields used here: `toolkitSlug: string`, `status: 'initializing'|'active'|'error'|'expired'|'disconnected'`, `linkUrl: string | null`, `error: string | null`.
- **Route conventions** (see `app/api/projects/[slug]/errors/route.ts`): `export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';`, params is `Promise<{ slug: string }>` (await it), gate with `requireAllowedUser()` catching `UnauthorizedError` → 401, return `Response.json({ ok, ... }, { status })`.
- **Client tab pattern** (see `components/RevenueTab.tsx`): `'use client'`, plain `fetch`, `useState` discriminated-union state, cancel-token cleanup in `useEffect`.
- **Vitest route-test pattern** (see `test/ingest-route.test.ts`): import the handler, build a `new Request(url, {...})`, call it, assert `res.status` + `await res.json()`. The `@` alias works in `vi.mock('@/lib/...')`.
- **Gates** (run from repo root `/Users/danziger/code/mission`): `npm test` (vitest), `npx tsc --noEmit` (typecheck), `npm run build` (Next build — authoritative full type + route check). `npm run lint` runs bare `eslint` with no flat config present and is effectively a no-op; do not rely on it.

---

### Task 1: Pure catalog↔connection merge (`lib/composio-view.ts`)

**Files:**
- Create: `lib/composio-view.ts`
- Test: `test/composio-view.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/composio-view.test.ts`:

```ts
// ABOUTME: Unit tests for toolkitViews — overlays a project's connection rows onto the static catalog.
// ABOUTME: Pure (no DB/network); proves the not_connected fallback, status overlay, linkUrl gating, toolCount.

import { describe, it, expect } from 'vitest';
import { toolkitViews } from '../lib/composio-view';
import type { ComposioConnection } from '../lib/db/schema';

function conn(partial: Partial<ComposioConnection>): ComposioConnection {
  return {
    id: 'id', projectId: 'p', toolkitSlug: 'linear', userId: 'mc-proj-p',
    connectedAccountId: null, status: 'active', linkUrl: null, error: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...partial,
  } as ComposioConnection;
}

describe('toolkitViews', () => {
  it('returns one view per catalog toolkit, sorted, all not_connected when no connections', () => {
    const views = toolkitViews([]);
    expect(views.map((v) => v.slug)).toEqual(['linear', 'slack']); // catalogSlugs() is sorted
    expect(views.every((v) => v.status === 'not_connected')).toBe(true);
    expect(views.every((v) => v.linkUrl === null && v.error === null)).toBe(true);
  });

  it('reports the catalog tool count and display name', () => {
    const [linear, slack] = toolkitViews([]);
    expect(linear.name).toBe('Linear');
    expect(linear.toolCount).toBe(4);
    expect(slack.name).toBe('Slack');
    expect(slack.toolCount).toBe(3);
  });

  it('overlays a connection status onto its toolkit', () => {
    const views = toolkitViews([conn({ toolkitSlug: 'linear', status: 'active' })]);
    expect(views.find((v) => v.slug === 'linear')!.status).toBe('active');
    expect(views.find((v) => v.slug === 'slack')!.status).toBe('not_connected');
  });

  it('exposes linkUrl ONLY while initializing', () => {
    const initializing = toolkitViews([conn({ toolkitSlug: 'linear', status: 'initializing', linkUrl: 'https://connect.composio.dev/link/x' })]);
    expect(initializing.find((v) => v.slug === 'linear')!.linkUrl).toBe('https://connect.composio.dev/link/x');
    const active = toolkitViews([conn({ toolkitSlug: 'linear', status: 'active', linkUrl: 'https://connect.composio.dev/link/x' })]);
    expect(active.find((v) => v.slug === 'linear')!.linkUrl).toBeNull(); // not surfaced once active
  });

  it('passes the connection error through', () => {
    const views = toolkitViews([conn({ toolkitSlug: 'slack', status: 'error', error: 'boom' })]);
    expect(views.find((v) => v.slug === 'slack')!.error).toBe('boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- composio-view`
Expected: FAIL — `Cannot find module '../lib/composio-view'`.

- [ ] **Step 3: Write the implementation**

Create `lib/composio-view.ts`:

```ts
// ABOUTME: Pure overlay of a project's Composio connection rows onto the static catalog. Every catalog
// ABOUTME: toolkit yields a ToolkitView; toolkits with no row are 'not_connected'. No DB, no network.

import type { ComposioConnection } from './db/schema';
import { COMPOSIO_CATALOG, catalogSlugs } from './composio-catalog';

export type ToolkitStatus =
  | 'active' | 'initializing' | 'error' | 'expired' | 'disconnected' | 'not_connected';

export type ToolkitView = {
  slug: string;
  name: string;
  toolCount: number;
  status: ToolkitStatus;
  linkUrl: string | null; // only meaningful while initializing
  error: string | null;
};

/** Overlay a project's connection rows onto the full static catalog. */
export function toolkitViews(connections: ComposioConnection[]): ToolkitView[] {
  const bySlug = new Map(connections.map((c) => [c.toolkitSlug, c]));
  return catalogSlugs().map((slug) => {
    const entry = COMPOSIO_CATALOG[slug];
    const conn = bySlug.get(slug);
    return {
      slug,
      name: entry.name,
      toolCount: entry.allowedTools.length,
      status: (conn?.status ?? 'not_connected') as ToolkitStatus,
      linkUrl: conn?.status === 'initializing' ? (conn.linkUrl ?? null) : null,
      error: conn?.error ?? null,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- composio-view`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/composio-view.ts test/composio-view.test.ts
git commit -m "feat: composio-view — pure catalog↔connection merge for the integrations tab"
```

---

### Task 2: GET+POST API route (`app/api/projects/[slug]/composio/route.ts`)

**Files:**
- Create: `app/api/projects/[slug]/composio/route.ts`
- Test: `test/composio-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/composio-route.test.ts`:

```ts
// ABOUTME: Tests for the project Composio route — GET merges catalog+connections; POST dispatches
// ABOUTME: connect/status/disconnect and maps NotFound/Validation/ComposioApi/Unauthorized to status codes.
// ABOUTME: CI-safe: mocks the auth gate + the lifecycle lib (no DB, no Composio network).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError, ValidationError } from '../lib/validation';
import { ComposioApiError } from '../lib/composio-api';

class FakeUnauthorized extends Error {}

const requireAllowedUser = vi.fn(async () => ({ user: { email: 'joe@ticc.net' } }));
vi.mock('@/lib/authz', () => ({
  requireAllowedUser: () => requireAllowedUser(),
  UnauthorizedError: FakeUnauthorized,
}));

const lib = {
  listConnections: vi.fn(),
  connectStart: vi.fn(),
  connectPoll: vi.fn(),
  disconnect: vi.fn(),
};
vi.mock('@/lib/composio-connections', () => lib);

// Import AFTER mocks are registered.
const { GET, POST } = await import('../app/api/projects/[slug]/composio/route');

const params = Promise.resolve({ slug: 'demo' });
function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/projects/demo/composio', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAllowedUser.mockResolvedValue({ user: { email: 'joe@ticc.net' } });
});

describe('GET', () => {
  it('returns merged toolkit views', async () => {
    lib.listConnections.mockResolvedValue([
      { toolkitSlug: 'linear', status: 'active', linkUrl: null, error: null },
    ]);
    const res = await GET(new Request('http://localhost/api/projects/demo/composio'), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    const linear = json.data.toolkits.find((t: { slug: string }) => t.slug === 'linear');
    expect(linear.status).toBe('active');
    expect(linear.toolCount).toBe(4);
  });

  it('401 when the auth gate rejects', async () => {
    requireAllowedUser.mockRejectedValue(new FakeUnauthorized());
    const res = await GET(new Request('http://localhost/api/projects/demo/composio'), { params });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
  });
});

describe('POST dispatch', () => {
  it('connect → returns linkUrl + status', async () => {
    lib.connectStart.mockResolvedValue({ linkUrl: 'https://connect.composio.dev/link/x', connection: { status: 'initializing' } });
    const res = await post({ action: 'connect', toolkit: 'linear' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.linkUrl).toContain('connect.composio.dev');
    expect(json.data.status).toBe('initializing');
    expect(lib.connectStart).toHaveBeenCalledWith('demo', 'linear');
  });

  it('status → returns polled status', async () => {
    lib.connectPoll.mockResolvedValue({ status: 'active' });
    const res = await post({ action: 'status', toolkit: 'linear' });
    expect((await res.json()).data.status).toBe('active');
    expect(lib.connectPoll).toHaveBeenCalledWith('demo', 'linear');
  });

  it('disconnect → returns disconnected status', async () => {
    lib.disconnect.mockResolvedValue({ status: 'disconnected' });
    const res = await post({ action: 'disconnect', toolkit: 'linear' });
    expect((await res.json()).data.status).toBe('disconnected');
  });

  it('422 on missing toolkit', async () => {
    const res = await post({ action: 'connect' });
    expect(res.status).toBe(422);
  });

  it('422 on unknown action', async () => {
    const res = await post({ action: 'frobnicate', toolkit: 'linear' });
    expect(res.status).toBe(422);
  });
});

describe('POST error mapping', () => {
  it('NotFoundError → 404', async () => {
    lib.connectStart.mockRejectedValue(new NotFoundError('project', 'demo'));
    expect((await post({ action: 'connect', toolkit: 'linear' })).status).toBe(404);
  });

  it('ValidationError → 422', async () => {
    lib.connectStart.mockRejectedValue(new ValidationError('toolkit', 'unknown toolkit: x'));
    expect((await post({ action: 'connect', toolkit: 'x' })).status).toBe(422);
  });

  it('ComposioApiError → its status (or 502)', async () => {
    lib.connectStart.mockRejectedValue(new ComposioApiError('composio down'));
    const res = await post({ action: 'connect', toolkit: 'linear' });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('composio_api_error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- composio-route`
Expected: FAIL — cannot import `../app/api/projects/[slug]/composio/route`.

- [ ] **Step 3: Write the implementation**

Create `app/api/projects/[slug]/composio/route.ts`:

```ts
// ABOUTME: Composio integrations for a project. GET lists the catalog overlaid with this project's
// ABOUTME: connection statuses; POST drives connect/status/disconnect over the slice-2 lifecycle.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { listConnections, connectStart, connectPoll, disconnect } from '@/lib/composio-connections';
import { toolkitViews } from '@/lib/composio-view';
import { NotFoundError, ValidationError } from '@/lib/validation';
import { ComposioApiError } from '@/lib/composio-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Returns a 401 Response if the caller isn't allowed, else null. Rethrows non-auth errors. */
async function gate(): Promise<Response | null> {
  try {
    await requireAllowedUser();
    return null;
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    throw e;
  }
}

/** Map a lifecycle error to the right Response; rethrow anything unrecognized (→ Next 500). */
function mapError(e: unknown): Response {
  if (e instanceof NotFoundError) {
    return Response.json({ ok: false, error: 'not_found', message: e.message }, { status: 404 });
  }
  if (e instanceof ValidationError) {
    return Response.json({ ok: false, error: 'validation', message: e.message }, { status: 422 });
  }
  if (e instanceof ComposioApiError) {
    return Response.json({ ok: false, error: 'composio_api_error', message: e.message }, { status: e.status ?? 502 });
  }
  throw e;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const denied = await gate();
  if (denied) return denied;
  const { slug } = await params;
  try {
    const connections = await listConnections(slug);
    return Response.json({ ok: true, data: { toolkits: toolkitViews(connections) } });
  } catch (e) {
    return mapError(e);
  }
}

type PostBody = { action?: string; toolkit?: string };

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const denied = await gate();
  if (denied) return denied;
  const { slug } = await params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return Response.json({ ok: false, error: 'validation', message: 'invalid JSON body' }, { status: 422 });
  }
  const { action, toolkit } = body;
  if (!toolkit) {
    return Response.json({ ok: false, error: 'validation', message: 'toolkit required' }, { status: 422 });
  }

  try {
    switch (action) {
      case 'connect': {
        const { linkUrl, connection } = await connectStart(slug, toolkit);
        return Response.json({ ok: true, data: { linkUrl, status: connection.status } });
      }
      case 'status': {
        const connection = await connectPoll(slug, toolkit);
        return Response.json({ ok: true, data: { status: connection.status } });
      }
      case 'disconnect': {
        const connection = await disconnect(slug, toolkit);
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
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- composio-route`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add "app/api/projects/[slug]/composio/route.ts" test/composio-route.test.ts
git commit -m "feat: GET+POST /api/projects/[slug]/composio route over the connection lifecycle"
```

---

### Task 3: Row component + CSS (`components/IntegrationRow.tsx`)

**Files:**
- Create: `components/IntegrationRow.tsx`
- Modify: `app/globals.css` (append three classes after `.intg-control-label`, line ~1151)

No unit test (the repo has no jsdom/RTL); verified via `npx tsc --noEmit`.

- [ ] **Step 1: Add the CSS**

In `app/globals.css`, immediately after the `.intg-control-label { ... }` rule (line ~1151), add:

```css
.intg-actions { display: inline-flex; align-items: center; gap: 12px; }
.intg-tools { color: var(--ink-mute); font-weight: 400; }
.intg-error { color: var(--bad-ink); font-weight: 400; }
```

- [ ] **Step 2: Write the component**

Create `components/IntegrationRow.tsx`:

```tsx
'use client';

// ABOUTME: One toolkit row in the Integrations tab — status pill + Connect/Check status/Disconnect.
// ABOUTME: Posts to /api/projects/[slug]/composio; opens the Composio hosted link on connect.

import { useState } from 'react';
import type { ToolkitView, ToolkitStatus } from '@/lib/composio-view';

function pillClass(status: ToolkitStatus): string {
  switch (status) {
    case 'active': return 'pill ok';
    case 'initializing': return 'pill warn';
    case 'error':
    case 'expired': return 'pill bad';
    default: return 'pill'; // not_connected | disconnected
  }
}

function pillLabel(status: ToolkitStatus): string {
  switch (status) {
    case 'active': return 'Active';
    case 'initializing': return 'Initializing';
    case 'error': return 'Error';
    case 'expired': return 'Expired';
    default: return 'Off'; // not_connected | disconnected
  }
}

type PostResult = { ok: boolean; data?: { linkUrl?: string; status?: string }; message?: string; error?: string };

export function IntegrationRow({
  slug,
  view,
  onChanged,
}: {
  slug: string;
  view: ToolkitView;
  onChanged: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  async function run(action: 'connect' | 'status' | 'disconnect') {
    setPending(true);
    setRowError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/composio`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, toolkit: view.slug }),
      });
      const json = (await res.json()) as PostResult;
      if (!json.ok) {
        setRowError(json.message ?? json.error ?? 'Request failed');
      } else if (action === 'connect' && json.data?.linkUrl) {
        window.open(json.data.linkUrl, '_blank', 'noopener');
      }
    } catch (err) {
      setRowError(String(err));
    } finally {
      setPending(false);
      await onChanged();
    }
  }

  const connected = view.status === 'active';
  const initializing = view.status === 'initializing';

  return (
    <div className="intg-control">
      <span className="intg-control-label">
        {view.name}
        <span className="intg-tools"> · {view.toolCount} tools</span>
        {initializing && view.linkUrl && (
          <>
            {' · '}
            <a className="detail-link" href={view.linkUrl} target="_blank" rel="noreferrer">open link ↗</a>
          </>
        )}
        {rowError && <span className="intg-error"> · {rowError}</span>}
      </span>
      <span className="intg-actions">
        <span className={pillClass(view.status)}>{pillLabel(view.status)}</span>
        {connected ? (
          <button type="button" className="btn-sm btn-bad" disabled={pending} onClick={() => void run('disconnect')}>
            Disconnect
          </button>
        ) : initializing ? (
          <button type="button" className="btn-sm" disabled={pending} onClick={() => void run('status')}>
            Check status
          </button>
        ) : (
          <button type="button" className="btn-sm btn-ok" disabled={pending} onClick={() => void run('connect')}>
            Connect
          </button>
        )}
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). If `ToolkitStatus` isn't exported from `lib/composio-view.ts`, it is (Task 1 exports both `ToolkitView` and `ToolkitStatus`).

- [ ] **Step 4: Commit**

```bash
git add components/IntegrationRow.tsx app/globals.css
git commit -m "feat: IntegrationRow — per-toolkit status pill + connect/disconnect actions"
```

---

### Task 4: Container component (`components/IntegrationsTab.tsx`)

**Files:**
- Create: `components/IntegrationsTab.tsx`

No unit test (no jsdom/RTL); verified via `npx tsc --noEmit` and exercised live.

- [ ] **Step 1: Write the component**

Create `components/IntegrationsTab.tsx`:

```tsx
'use client';

// ABOUTME: Integrations tab container — fetches the merged toolkit catalog for a project, renders a
// ABOUTME: row list, and re-polls any initializing connection when the window regains focus.

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ToolkitView } from '@/lib/composio-view';
import { IntegrationRow } from './IntegrationRow';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; toolkits: ToolkitView[] };

export function IntegrationsTab({ slug }: { slug: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const stateRef = useRef<State>(state);
  stateRef.current = state;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${slug}/composio`);
      const json = (await res.json()) as {
        ok: boolean; error?: string; message?: string; data?: { toolkits: ToolkitView[] };
      };
      if (json.ok && json.data) setState({ kind: 'data', toolkits: json.data.toolkits });
      else setState({ kind: 'error', message: json.message ?? json.error ?? 'Failed to load integrations' });
    } catch (err) {
      setState({ kind: 'error', message: String(err) });
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // On window focus, poll any still-initializing toolkit (the user just returned from authorizing), then refresh.
  useEffect(() => {
    async function onFocus() {
      const s = stateRef.current;
      if (s.kind !== 'data') return;
      const initializing = s.toolkits.filter((t) => t.status === 'initializing');
      if (initializing.length === 0) return;
      await Promise.all(
        initializing.map((t) =>
          fetch(`/api/projects/${slug}/composio`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'status', toolkit: t.slug }),
          }).catch(() => undefined),
        ),
      );
      await load();
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [slug, load]);

  if (state.kind === 'loading') {
    return (
      <div className="detail-integrations skeleton" aria-label="Loading integrations">
        <div className="skeleton-bar" />
        <div className="skeleton-bar" />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="detail-integrations">
        <p className="detail-muted">Failed to load integrations: {state.message}</p>
        <button
          type="button"
          className="btn-sm"
          onClick={() => {
            setState({ kind: 'loading' });
            void load();
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="detail-integrations">
      {state.toolkits.map((t) => (
        <IntegrationRow key={t.slug} slug={slug} view={t} onChanged={load} />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/IntegrationsTab.tsx
git commit -m "feat: IntegrationsTab container — fetch + focus-poll the toolkit catalog"
```

---

### Task 5: Wire into the detail page; remove the old tab; final gates

**Files:**
- Modify: `app/p/[slug]/page.tsx`
- Delete: `components/IntegrationControl.tsx`

- [ ] **Step 1: Edit `app/p/[slug]/page.tsx`**

Make exactly these changes:

1. **Remove** the import at line 13: `import { IntegrationControl } from '@/components/IntegrationControl';`
2. **Remove** the import at line 23: `import type { IntegrationStatus } from '@/lib/db/schema';`
3. **Add** an import (next to the other tab imports, e.g. after the `RevenueTab` import at line 22): `import { IntegrationsTab } from '@/components/IntegrationsTab';`
4. **Remove** the `INTG_LABEL` const (lines 27–33).
5. **Replace** the entire `integrationsPanel` block (lines 138–153) with:

```tsx
  const integrationsPanel = <IntegrationsTab slug={project.slug} />;
```

**Do NOT touch** line 80 (`const integrationTasks = project.tasks.filter((t) => t.integrationType);`) or the `boardIntegrations` block (lines 156–159) — `integrationTasks` still feeds the Board tab's integration count. **Do NOT touch** `app/actions.ts` (`setIntegrationStatus` stays as the data-layer write surface).

- [ ] **Step 2: Delete the dead component**

```bash
git rm components/IntegrationControl.tsx
```

- [ ] **Step 3: Verify no dangling references**

Run: `grep -rn "IntegrationControl\|INTG_LABEL" app components lib`
Expected: NO matches (both fully removed). If `integrationTasks` still appears at lines 80 + 157–158, that is correct — leave it.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — no unused-import or missing-symbol errors.

- [ ] **Step 5: Full test suite**

Run: `npm test`
Expected: PASS — all existing suites plus `composio-view` (5) and `composio-route` (10). (Real-Neon suites need `.env.local`; run serially per the vitest config.)

- [ ] **Step 6: Production build**

Run: `npm run build`
Expected: Build succeeds; the route `/api/projects/[slug]/composio` and the detail page compile with no type errors.

- [ ] **Step 7: Commit**

```bash
git add "app/p/[slug]/page.tsx"
git commit -m "feat: swap the Integrations tab to the live Composio catalog; remove the manual tri-state control"
```

---

## Live verification (after all tasks)

Done by the controller before finishing the branch — the OAuth consent step can't be automated (same as slice 2):

1. `npm run dev` (port 3030), sign in, open a project's **Integrations** tab → every catalog toolkit (Linear, Slack) renders as a row, status **Off**, with a **Connect** button.
2. Click **Connect** on Linear → a Composio hosted link opens in a new tab; the row flips to **Initializing** with an `open link ↗` fallback.
3. Authorize on Composio, return to the MC tab → on focus the row polls and flips to **Active** (also reachable via **Check status**).
4. Click **Disconnect** → the row returns to **Off**.
5. Confirm the **Board** tab's integration count still renders (proves `integrationTasks` was preserved).

## Self-review notes (plan author)

- **Spec coverage:** merge seam (Task 1), GET+POST route + error mapping (Task 2), row with three states + popup fallback + inline error (Task 3), container with focus-poll + retry (Task 4), page swap + dead-code removal + gates (Task 5), live verification (closeout). All spec sections map to a task.
- **Type consistency:** `ToolkitView`/`ToolkitStatus` defined in Task 1 and imported unchanged in Tasks 2–4; route response shapes (`{ toolkits }`, `{ linkUrl, status }`, `{ status }`) match what `IntegrationRow`/`IntegrationsTab` read.
- **Correction vs spec:** the spec said remove the `integrationTasks` filter; in fact it is still consumed by the Board count (page.tsx 156–159), so Task 5 explicitly preserves it and removes only the panel JSX + orphaned imports.

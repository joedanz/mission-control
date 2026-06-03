# Composio Integrations Tab UI — Design

**Status:** Approved 2026-06-02
**Slice:** `slice/composio-integrations-tab` — slice 3 of the Integrations-tab reshape
**Type:** UI + API routes over the slice-2 connection lifecycle. No schema changes.

## Goal

Replace the project detail page's old manual tri-state Integrations tab with a live catalog of
Composio long-tail toolkits (seeded: **Linear**, **Slack**). Each row shows the toolkit, this
project's connection status, and a **Connect / Disconnect** action — driven by the slice-2
`mc composio` connection lifecycle (`connectStart` / `connectPoll` / `listConnections` /
`disconnect`).

This is the operator-facing surface over the storage layer built in slice 2
(`2026-06-02-composio-connections-design.md`). It does **not** wire connections into agent profiles —
that is slice 4 (profile auto-feed).

## Background

The current Integrations tab (`app/p/[slug]/page.tsx` lines 138–153) is a server-rendered list of
`IntegrationControl` tri-state pickers driven by `tasks` rows with an `integrationType`. It is a manual
tracker, not a real connection. This slice fully replaces that tab content with a live Composio catalog.

The slice-2 lifecycle is already proven end-to-end (auth-config → hosted `/link` OAuth → `ACTIVE`
connected-account → MCP server → per-`user_id` URL). The hosted `/link` flow runs the entire OAuth
round-trip on `connect.composio.dev` and flips the connected account to `ACTIVE` on Composio's side, so
**MC needs no OAuth callback route** — the UI initiates the link, the user authorizes on Composio, and
the UI polls status.

## Decisions (locked during brainstorming)

1. **Mutations via POST API routes** (not server actions). Reads + writes go through one route file;
   the client uses plain `fetch` like the Email/Errors/Revenue tabs. `connectStart` returns the
   `linkUrl` directly in the JSON response, which the client opens.
2. **Status refresh via window-focus + manual button.** After the user authorizes on Composio's hosted
   page (a new tab) and returns to MC, a `focus` listener polls any `initializing` row; a per-row
   **Check status** button does the same on demand. No perpetual timers / intervals.
3. **Fully replace the old tracker.** The Integrations tab becomes the Composio catalog only.
   `IntegrationControl` rendering + the `integrationTasks` filter are removed. The
   `setIntegrationStatus` server action, the `mc integration` CLI, and the
   `integrationType`/`integrationStatus` task columns are **kept** — only the tab UI changes.

## Layout

A **row list** — one full-width row per catalog toolkit (reuses the existing `.intg-control` row
style). Each row: toolkit name + tool count on the left; a status `.pill` + the action button on the
right. Three visible states: **Active** (connected → Disconnect), **Off / not_connected** (→ Connect),
**Initializing** (authorizing → shows `open link ↗` fallback + **Check status**).

## File structure

### New — pure merge seam (testable without HTTP/DB)

**`lib/composio-view.ts`**

```ts
import type { ComposioConnection } from './db/schema';
import { COMPOSIO_CATALOG, catalogSlugs } from './composio-catalog';

export type ToolkitStatus =
  | 'active' | 'initializing' | 'error' | 'expired' | 'disconnected' | 'not_connected';

export type ToolkitView = {
  slug: string;
  name: string;
  toolCount: number;
  status: ToolkitStatus;
  linkUrl: string | null;   // only meaningful while initializing
  error: string | null;
};

/** Overlay a project's connection rows onto the full static catalog. Every catalog toolkit gets a
 *  ToolkitView; toolkits with no connection row are 'not_connected'. Pure — no DB, no network. */
export function toolkitViews(connections: ComposioConnection[]): ToolkitView[] {
  const bySlug = new Map(connections.map((c) => [c.toolkitSlug, c]));
  return catalogSlugs().map((slug) => {
    const entry = COMPOSIO_CATALOG[slug];
    const conn = bySlug.get(slug);
    return {
      slug,
      name: entry.name,
      toolCount: entry.allowedTools.length,
      status: conn ? (conn.status as ToolkitStatus) : 'not_connected',
      linkUrl: conn?.status === 'initializing' ? (conn.linkUrl ?? null) : null,
      error: conn?.error ?? null,
    };
  });
}
```

### New — API route (one file; GET list + POST mutations)

**`app/api/projects/[slug]/composio/route.ts`** — follows the repo route conventions
(`runtime='nodejs'`, `dynamic='force-dynamic'`, `requireAllowedUser()`, `Response.json({ ok, ... })`),
and the `/api/ingest` switch-on-action idiom for POST.

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET → { ok:true, data:{ toolkits: ToolkitView[] } }
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> { /* auth → listConnections(slug) → toolkitViews → json */ }

// POST body: { action:'connect'|'status'|'disconnect', toolkit:string }
//   connect    → connectStart  → { ok:true, data:{ linkUrl, status:'initializing' } }
//   status     → connectPoll   → { ok:true, data:{ status } }
//   disconnect → disconnect    → { ok:true, data:{ status:'disconnected' } }
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> { /* auth → parse → switch(action) → json */ }
```

**Error mapping** (mirrors `app/api/projects/[slug]/errors/route.ts`):

| thrown | HTTP | body |
|---|---|---|
| `UnauthorizedError` | 401 | `{ ok:false, error:'unauthorized' }` |
| `NotFoundError` (project / connection) | 404 | `{ ok:false, error:'not_found' }` |
| `ValidationError` (unknown toolkit / bad action) | 422 | `{ ok:false, error:'validation', message }` |
| `ComposioApiError` | 502 (or `e.status`) | `{ ok:false, error:'composio_api_error', message }` |

The Composio API key lives only in request **headers** inside `composioFetch` — it never appears in a
thrown `ComposioApiError.message`, so passing `message` to the browser leaks no secret.

### New — components

**`components/IntegrationsTab.tsx`** — `'use client'`. Container.
- Props: `{ slug: string }`.
- State machine: `{ kind:'loading' } | { kind:'error', message } | { kind:'data', toolkits: ToolkitView[] }`.
- Fetches `GET /api/projects/${slug}/composio` on mount (cancel-token cleanup, like `RevenueTab`) and
  exposes a `refresh()` that re-fetches.
- Registers a `window` `focus` listener: on focus, if any current toolkit is `initializing`, POST
  `{action:'status'}` for each such toolkit, then `refresh()`. Listener cleaned up on unmount.
- Renders one `<IntegrationRow>` per toolkit, passing the view + `slug` + `refresh`.

**`components/IntegrationRow.tsx`** — `'use client'`. One toolkit row.
- Props: `{ slug, view: ToolkitView, onChanged: () => void }`.
- Local state: `pending: boolean`, `rowError: string | null`.
- Renders name + `toolCount` tools, the status `.pill` (mapped: active→`pill ok`, initializing→`pill
  warn`, error/expired→`pill bad`/`pill warn`, not_connected/disconnected→neutral), and the action
  button:
  - `not_connected` / `disconnected` → **Connect**: POST `{action:'connect'}` → on success
    `window.open(data.linkUrl, '_blank')`, then `onChanged()`. If the row is `initializing` it also
    shows `open link ↗` (the stored `linkUrl`) as a popup-blocked fallback.
  - `initializing` → **Check status**: POST `{action:'status'}` → `onChanged()`.
  - `active` → **Disconnect**: POST `{action:'disconnect'}` → `onChanged()`.
- On any POST failure: set `rowError` (inline, this row only); the rest of the list stays usable.

### Modified

**`app/p/[slug]/page.tsx`**
- Replace the `integrationsPanel` JSX (lines 138–153) with `const integrationsPanel = <IntegrationsTab slug={project.slug} />;`.
- Remove the `integrationTasks` filter (line 80) and the now-unused `IntegrationControl` + `INTG_LABEL`
  imports / map (verify no other consumer before deleting `INTG_LABEL`).

### Removed (dead after full replace)

**`components/IntegrationControl.tsx`** — only consumer was the old tab. Deleting it does not touch the
`setIntegrationStatus` server action (kept) or the `mc integration` CLI (kept).

## Data flow

```
IntegrationsTab (mount / focus)
  → GET /api/projects/[slug]/composio
      → requireAllowedUser → listConnections(slug) → toolkitViews(connections) → { toolkits }
  → render rows

IntegrationRow Connect
  → POST { action:'connect', toolkit }
      → connectStart(slug, toolkit) → { linkUrl }
  → window.open(linkUrl) ; onChanged() → container refresh (row now 'initializing')

user authorizes on connect.composio.dev → returns to MC tab → window 'focus'
  → POST { action:'status', toolkit } for each initializing row
      → connectPoll(slug, toolkit) → status
  → refresh → row 'active'

IntegrationRow Disconnect
  → POST { action:'disconnect', toolkit } → disconnect(slug, toolkit) → 'disconnected'
  → refresh → row 'not connected'
```

## Error handling

- **GET failure** → tab-level `error` state with the message + a Retry control.
- **Row action failure** → inline `rowError` on that row only; other rows remain interactive.
- **Missing `COMPOSIO_API_KEY`** on the server → surfaces as the generic `composio_api_error` on the
  affected row (no dedicated "not configured" UI — it's an operator env requirement; YAGNI).
- **Popup blocked** on `window.open` → the `initializing` row shows the stored `linkUrl` as
  `open link ↗`, so the user can still reach the hosted page.

## Testing

- **Unit (CI-safe, no network/DB) — `test/composio-view.test.ts`:**
  - every catalog toolkit yields a `ToolkitView` (Linear + Slack present);
  - an un-connected toolkit → `status:'not_connected'`, `linkUrl:null`, `error:null`;
  - a connection row overlays its `status` (e.g. `active`), and `linkUrl` is exposed **only** when
    `initializing`;
  - `toolCount` equals the catalog allow-list length (Linear 4, Slack 3).
- **Route handler tests — `test/composio-route.test.ts`:** mock `lib/composio-connections`; assert
  - GET → `{ ok:true, data:{ toolkits } }` (merged views);
  - POST dispatches `connect` / `status` / `disconnect` to the right lifecycle function and returns its
    result;
  - each error class maps to its status code (NotFound→404, Validation→422, ComposioApi→502,
    Unauthorized→401);
  - a missing/unknown `action` → 422.
  (Confirm during planning whether a route-test harness already exists; if not, import the exported
  `GET`/`POST` directly with the lib mocked — no running server needed.)
- **No component tests** — the repo runs node-env Vitest with no jsdom/RTL. The logic worth testing is
  in `composio-view` + the route, both covered above.
- **Live verification** — load the tab in the running app for a real project: Connect Linear →
  authorize on Composio → return → focus flips the row to **Active** → Disconnect. Same live pattern as
  slice 2.

## Out of scope (later slices)

- **Profile auto-feed (slice 4):** turning a project's ACTIVE connections into the `mcpServers` a
  spawned agent receives.
- Token-expiry / re-auth automation; multiple connected accounts per (project, toolkit); orphaned
  connected-account cleanup on reconnect (carried over from slice 2's deferred list).
- Any change to the `integrationType`/`integrationStatus` task data or the `mc integration` CLI.

## Open assumptions / risks

- **Focus-poll scope.** The `focus` listener only polls toolkits currently `initializing`, so a tab
  left open does no background work. If the user authorizes but never refocuses the MC tab, the row
  stays `initializing` until they click **Check status** — acceptable and explicit.
- **Route-test harness.** Assumes the route handlers can be unit-tested by importing `GET`/`POST` with
  `lib/composio-connections` mocked. Planning verifies this against an existing route test (if any);
  the `composio-view` unit tests cover the merge logic regardless.
- **`INTG_LABEL` / `IntegrationControl` removal.** Assumes the old tab is the only consumer. Planning
  greps for other references before deleting.

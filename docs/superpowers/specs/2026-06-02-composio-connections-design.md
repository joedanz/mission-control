# Composio Connection Storage + Connect Flow — Design

**Status:** Approved 2026-06-02
**Slice:** `slice/composio-connections` — foundation slice of the Integrations-tab reshape (slice 2 of the reshape)
**Type:** Backend foundation. No UI.

## Goal

A server-side connection lifecycle for long-tail Composio toolkits (seeded: **Linear**, **Slack**),
stored in MC and exercised via `mc composio` commands. This is the data layer the reshaped
Integrations tab (next slice) and the profile auto-feed (later slice) build on. No UI in this slice.

Builds directly on the proven loop (see `2026-06-02-composio-linear-agent-loop-design.md`): the
Composio v3 connect flow is already validated end-to-end (auth-config → hosted `/link` OAuth →
`ACTIVE` connected-account → MCP server → per-`user_id` URL → agent acts). This slice makes that flow
first-class and per-project instead of a one-off manual setup.

## Background

The Integrations tab today is a dead manual tracker (`tasks kind='integration'` + `IntegrationControl`
tri-state). The reshape replaces it with real connections to long-tail services brokered by Composio,
which then feed the project's agent-profile `mcpServers`. This slice builds the storage + lifecycle;
it does **not** touch the old tab (slice 2 does).

Key simplification carried from the proof: Composio's **hosted `/link` flow** runs the entire OAuth
round-trip on `connect.composio.dev` — the connected account flips to `ACTIVE` on Composio's side, so
**MC needs no OAuth callback route**. The lifecycle is: initiate link → user authorizes on Composio →
poll status.

## Data model — static catalog (code) + two tables

### `lib/composio-catalog.ts` (static, code)

The supported toolkits and their curated allow-lists. Static because the tool lists and display names
are editorial, not runtime state.

```ts
export type CatalogEntry = { name: string; allowedTools: string[] };
export const COMPOSIO_CATALOG: Record<string, CatalogEntry> = {
  linear: {
    name: 'Linear',
    allowedTools: ['LINEAR_LIST_LINEAR_TEAMS', 'LINEAR_CREATE_LINEAR_ISSUE', 'LINEAR_GET_LINEAR_ISSUE', 'LINEAR_LIST_LINEAR_ISSUES'],
  },
  slack: {
    name: 'Slack',
    allowedTools: [/* curated during planning by querying GET /api/v3/tools?toolkit_slug=slack */],
  },
};
```

### `composio_toolkits` table (cached shared Composio resources)

The auth-config + MCP server for a toolkit are shared across all projects (the per-project connection
is selected by `user_id` in the MCP URL). They are created once and cached here.

| column | type | notes |
|---|---|---|
| `slug` | text PK | matches a catalog key |
| `auth_config_id` | text | Composio `ac_…`, created once |
| `mcp_server_id` | text | Composio MCP server id, created once |
| `mcp_url` | text | base, e.g. `https://backend.composio.dev/v3/mcp/<id>` |
| `created_at`/`updated_at` | timestamptz | |

Populated lazily + idempotently by `ensureToolkit(slug)`.

### `composio_connections` table (per project + toolkit)

| column | type | notes |
|---|---|---|
| `id` | text PK | uuid |
| `project_id` | text FK→projects.id (cascade) | |
| `toolkit_slug` | text | catalog key |
| `user_id` | text | `mc-proj-<projectId>` — stable per project |
| `connected_account_id` | text, nullable | Composio `ca_…`, set once link initiated |
| `status` | text | `initializing` \| `active` \| `error` \| `expired` \| `disconnected` |
| `link_url` | text, nullable | transient hosted link for an in-flight connect |
| `error` | text, nullable | last error detail |
| `created_at`/`updated_at` | timestamptz | |

**Unique `(project_id, toolkit_slug)`** — one connection per toolkit per project.

`user_id` = `mc-proj-<projectId>` (one per project, reused across toolkits — each toolkit has its own
auth-config, so `(user_id, auth_config)` uniquely identifies a connection). The per-project MCP URL is
**derived** (`mcp_url + '?user_id=' + user_id`), never stored.

## Connect flow

### `lib/composio-api.ts` — fetch client (no SDK; runs on Vercel)

Mirrors the proven v3 calls. Auth header `x-api-key: ${COMPOSIO_API_KEY}` (env, server-side only).

- `ensureToolkit(slug)` — idempotent: if no `auth_config_id`, `POST /api/v3/auth_configs`
  `{toolkit:{slug}, auth_config:{type:'use_composio_managed_auth', name:'mc-<slug>'}}`; if no
  `mcp_server_id`, `POST /api/v3/mcp/servers` `{name:'mc-<slug>', auth_config_ids:[…], allowed_tools:[…from catalog]}`
  → returns `{auth_config_id, mcp_server_id, mcp_url}`. Reuses existing resources by name where the API
  allows; otherwise the `composio_toolkits` cache means it only runs once per toolkit anyway.
- `initiateConnection(authConfigId, userId)` — `POST /api/v3/connected_accounts/link`
  `{auth_config_id, user_id}` → `{redirect_url, connected_account_id}`.
- `connectionStatus(connectedAccountId)` — `GET /api/v3/connected_accounts/{id}` → `{status}`
  (`ACTIVE`/`INITIALIZING`/…), mapped to our lowercase enum.
- `deleteConnection(connectedAccountId)` — `DELETE /api/v3/connected_accounts/{id}`.

### `lib/composio-connections.ts` — MC lifecycle (DB + api client)

- `connectStart(projectSlug, toolkitSlug)` — validate toolkit in catalog → `ensureToolkit` (cache
  resources in `composio_toolkits`) → derive `user_id` → `initiateConnection` → upsert
  `composio_connections` (status `initializing`, store `connected_account_id` + `link_url`). Returns
  `{link_url}`.
- `connectPoll(projectSlug, toolkitSlug)` — `connectionStatus` → update row status → return status.
- `listConnections(projectSlug)` — rows for the project (joined with catalog name).
- `disconnect(projectSlug, toolkitSlug)` — `deleteConnection` → set status `disconnected`.

## CLI surface — `mc composio`

| command | does |
|---|---|
| `mc composio catalog` | list supported toolkits (from code catalog) |
| `mc composio connect <project> <toolkit>` | initiate; prints the Composio hosted link to open |
| `mc composio status <project> <toolkit>` | poll Composio; update + print status |
| `mc composio list <project>` | a project's connections + statuses |
| `mc composio disconnect <project> <toolkit>` | revoke + mark disconnected |

Standard `mc` envelope (`{ok,data}` / `{ok:false,error}`); validation on unknown toolkit/project
(VALIDATION/NOT_FOUND). `mc spec`/`mc enums` kept in sync (the repo's `test/spec-sync.test.ts`).

## Testing

- **CI-safe unit tests** (fetch mocked, no network): `user_id` derivation, Composio status→enum mapping,
  derived MCP URL, and `ensureToolkit` create-vs-reuse branching.
- **DB tests** (real Neon, repo convention; self-cleaning rows): `composio_connections` upsert / list /
  disconnect / the `(project_id, toolkit_slug)` unique constraint; `composio_toolkits` cache upsert.
- **Live flow**: exercised manually via `mc composio connect/status` (OAuth consent can't be automated),
  same pattern as the proof slice.

## Migration

New tables `composio_toolkits` + `composio_connections`, with grants appended for **both** `mc_agent`
and `cc_agent` (the repo's hand-appended-grants convention; guard with `DO $$ … IF EXISTS`).

## Secrets

`COMPOSIO_API_KEY` stays in env (server-side only). Connection/toolkit rows hold only Composio resource
IDs (`ac_…`, `ca_…`, server id) + URLs — **no secrets**. Consistent with the profile placeholder model.

## Out of scope (later slices)

- The reshaped Integrations tab UI (slice 2) — the old `IntegrationControl` tab is **left untouched** here.
- API routes (`app/api/projects/[slug]/composio/…`) — added with the UI slice.
- Profile auto-feed (slice 3): turning a project's ACTIVE connections into the `mcpServers` a spawned
  agent receives.
- Token-expiry / re-auth automation; multiple accounts per (project, toolkit); a generic OAuth callback
  route (Composio hosts it).

## Next slices (preview)

2. **Reshaped Integrations tab** — catalog grid, per-service Connect (→ Composio link), status badges,
   disconnect; API routes over this slice's lifecycle.
3. **Profile auto-feed** — a project's ACTIVE connections become the `mcpServers` a spawned agent gets,
   so auto-claim/scheduled agents inherit the tools (the daemon resolves connections → MCP config at
   spawn). See [[project_composio_longtail_integrations]].

## Open assumptions / risks

- **`ensureToolkit` idempotency.** Creating an auth-config / MCP server is the only non-idempotent
  Composio call; the `composio_toolkits` cache makes it run once per toolkit. If two connects race
  before the cache is populated, we could create duplicate Composio resources — acceptable for a
  single-user tool; planning will add a simple guard (cache-check inside a transaction or accept the
  rare dup).
- **Slack allow-list** is curated during planning by querying `GET /api/v3/tools?toolkit_slug=slack`
  (the Linear slugs carried a `_LINEAR_` infix; Slack likely similar).

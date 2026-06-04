# Unified MCP Connections (Composio + Remote) — Design

**Status:** Approved 2026-06-04
**Slices:** `slice/mcp-rename`, `slice/mcp-catalog`, `slice/mcp-remote`, `slice/mcp-tab`, `slice/mcp-legacy-removal` (5 slices)
**Type:** Refactor (rename) + feature (full catalog, remote servers, UI) + cleanup (legacy removal).

## Goal

Collapse the project's integration surface into one concept — **MCP servers attached to a
project** — with two sources:

- **`composio`** — a Composio-brokered toolkit (any of Composio's full catalog), connected via
  hosted OAuth. Each connected toolkit is exposed as its own remote-http MCP server.
- **`remote`** — a direct remote-http MCP server the user supplies by URL + auth header. No OAuth.

Both resolve to the same `McpServerConfig` (`{type:'http', url, headers}`) and ride the **existing**
spawn path (`mergeMcpServers` → `--mcp-config`, `daemon/render-profile.ts:70`). The agent-facing
delivery of MCP servers does not change; only the set of *sources* widens.

Three user-visible outcomes:
1. Users can connect **any** Composio toolkit, not just the hardcoded editorial pair (Linear, Slack).
2. Users can add **any remote MCP server** by URL.
3. The `mc composio` namespace and the "Integrations" tab become **MCP** — shorter and accurate.

And one cleanup: the unrelated legacy `mc integration` status-tracker (which shares the confusing
word "integration") is deleted.

## Background

Today there are two orthogonal things both called "integration":

1. **Functional (Composio):** `composio_connections` + `composio_toolkits` tables, `mc composio` CLI,
   and the Integrations tab. These produce real MCP servers fed to agents
   (`lib/composio-connections.ts:95` `resolveProjectMcpServers` → `lib/composio-mcp.ts:17`
   `buildConnectionMcpServers` → `daemon/runner.ts:79` `fetchComposioMcpServers` → merge at
   `daemon/runner.ts:201`). Profile-defined servers win on key collision
   (`daemon/render-profile.ts:70` `mergeMcpServers`).
2. **Legacy status tracking:** `tasks.kind='integration'` rows with `integration_type` ∈
   `['google_oauth','stripe','sentry','zoho_email','other']` (`lib/db/schema.ts:32`) +
   `integration_status` ∈ `['needed','pending','done']`. Purely dashboard badges
   (`lib/mutations.ts:525` `upsertIntegration`, `lib/ui.ts:145` `integrationStatusOf`,
   `components/ProjectRow.tsx`). It calls no APIs and feeds no agents. The Errors/Revenue tabs read
   `projects.sentryProject` / `projects.stripeSite` columns directly, **not** these rows — so deleting
   the rows does not break those tabs.

Composio's connect flow is already slug-generic: `createAuthConfig(toolkitSlug)`
(`lib/composio-api.ts:72`) POSTs `{toolkit:{slug}}` for *any* slug. The only things gating "any
toolkit" are the static `COMPOSIO_CATALOG` editorial list (`lib/composio-catalog.ts`) used for
discovery, and the per-toolkit `allowedTools` passed to `createMcpServer` (`lib/composio-api.ts:88`).

## Naming carve-out (precision)

`composio` survives as a name **only** where the code is genuinely Composio-specific and not MCP:

- `lib/composio-api.ts` — the Composio v3 REST client.
- `composio_toolkits` table — the shared auth-config/MCP-server cache; only `composio`-source rows
  touch it. Stays named `composio_toolkits`.
- The **workflow integration node** — calls `executeAction` (REST, **not** MCP). Renaming it to
  "mcp" would mislabel it. It keeps the name "integration" and its `IntegrationNodeData`
  (`toolkit`, `action`, `arguments`) shape; it references a connected `composio`-source row.

Everything user-facing — the CLI namespace, the connections table, the tab — becomes **MCP**.

## Data model

### `mcp_connections` table (renamed from `composio_connections`, + `source`)

One row per MCP server attached to a project. `source` discriminates the two shapes.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | unchanged |
| `project_id` | uuid FK | unchanged |
| `source` | text | **new**, `'composio' \| 'remote'`, default `'composio'` |
| `toolkit_slug` | text | composio source: the toolkit; remote source: null |
| `connected_account_id` | text | composio source: Composio `ca_…`; remote: null |
| `user_id` | text | composio source: `mc-proj-<projectId>`; remote: null |
| `remote_name` | text | **new**, remote source: display name + MCP server key; composio: null |
| `remote_url` | text | **new**, remote source: the MCP endpoint URL; composio: null |
| `remote_headers` | jsonb | **new**, remote source: `Record<string,string>` of `${ENV}`-placeholder header values; composio: null |
| `status` | text | composio: lifecycle (`initializing\|active\|error\|expired\|disconnected`); remote: pinned `'active'` |
| timestamps | | unchanged |

Uniqueness: composio rows unique on `(project_id, toolkit_slug)` (as today); remote rows unique on
`(project_id, remote_name)`.

### `composio_toolkits` table — unchanged

Still the shared auth-config + MCP-server cache for `composio`-source rows. Not renamed.

### Resolver — `resolveProjectMcpServers` branches on `source`

```ts
// lib/composio-connections.ts (file may be renamed lib/mcp-connections.ts in slice 1)
const active = (await listConnectionsByProject(projectId)).filter(c => c.status === 'active');
// composio rows → today's buildConnectionMcpServers (join composio_toolkits for mcpUrl)
// remote rows   → { [remote_name]: { type:'http', url: remote_url, headers: remote_headers } }
return { ...composioServers, ...remoteServers };
```

Both halves emit the same `McpServerConfig` shape, so `daemon/runner.ts` and the profile merge are
unchanged. `${ENV}` placeholders in `remote_headers` are resolved at spawn by the existing
`resolveMcpConfigJson` (`daemon/render-profile.ts:44`) — secrets stay out of the DB and out of `ps`.

## CLI surface: `mc composio …` → `mc mcp …`

| Command | Behavior |
|---|---|
| `mc mcp catalog [--search <q>] [--limit <n>]` | Lists Composio's **full live catalog** via a new `listToolkits()` (Composio `GET /api/v3/toolkits`). Featured toolkits (Linear, Slack) flagged. No DB; reads `COMPOSIO_API_KEY`. |
| `mc mcp connect <slug> <toolkit>` | Connect any toolkit via hosted OAuth. `allowedTools` resolved via new `listToolkitTools(slug)` (`GET /api/v3/tools?toolkit_slug=<slug>`); if Composio accepts an empty `allowed_tools` as "all", default to that and skip the call. |
| `mc mcp status <slug> <toolkit>` | Poll + persist a composio connection's status (unchanged). |
| `mc mcp add-remote <slug> --name <n> --url <u> [--header K=V …]` | **New.** Insert a `remote`-source row. Header values are `${ENV}` placeholders (validated: no literal secrets). Instant; status `active`. |
| `mc mcp remove-remote <slug> <name>` | **New.** Delete a remote row. |
| `mc mcp list <slug>` | Lists **both** sources together (source-tagged). |
| `mc mcp disconnect <slug> <toolkit-or-name>` | Revoke a composio connection at Composio, or delete a remote row. |
| `mc mcp refresh <slug>` | Re-poll **composio** rows only (remote rows have no lifecycle). |
| `mc mcp config <slug>` | Resolve **both** sources into an `mcpServers` map (was `mc composio mcp-config`). |

`connect` (async OAuth) and `add-remote` (instant) stay distinct verbs because the flows differ.

## UI: "Integrations" tab → "MCP" tab

- Lists the project's MCP servers, source-tagged (Composio / Remote).
- **Browse catalog:** searchable Composio catalog → click a toolkit → OAuth connect (hosted `/link`).
- **Add remote server:** form (name / URL / header key+value) → `add-remote`.

This is the "easily add" experience — moves connect/add out of the terminal.

## Legacy removal

Delete the status-tracking "integration" concept entirely:

- `mc integration set|list` (`cli/index.ts:849`), `upsertIntegration` (`lib/mutations.ts:525`),
  `integrationStatusOf` (`lib/ui.ts:145`), the ProjectRow status chips
  (`components/ProjectRow.tsx:92`).
- Schema: drop `tasks.integration_type`, `tasks.integration_status`, and the `INTEGRATION_TYPES` /
  integration-status enums (`lib/db/schema.ts:32`). The `tasks.kind` column is currently
  `'custom' \| 'integration'`; after removal all tasks are custom — collapse `kind` (drop the column,
  or pin it to `'custom'`) and remove `--kind` from `mc task list`. **Validate during planning** which
  task code still reads `kind`.
- `mc enums` / `mc spec`: remove the integration enums.

The Errors/Revenue tabs are untouched (they read project columns, not these rows).

## Slices (each its own squash-merged PR)

1. **`slice/mcp-rename`** — Rename `mc composio` → `mc mcp`; `composio_connections` →
   `mcp_connections` with additive `source` column (default `'composio'`); rename lib files where
   they're MCP-generic (`composio-connections.ts` → `mcp-connections.ts`, `composio-mcp.ts` keep or
   rename). **Behavior byte-identical.** Update docs + AGENTS.md + memory. Foundational; unblocks the
   rest.
2. **`slice/mcp-catalog`** — `listToolkits()` + `mc mcp catalog --search`; `connect` any toolkit;
   `listToolkitTools()` for `allowedTools` (or all-tools default). Featured-flagging retained.
3. **`slice/mcp-remote`** — remote-source columns, `add-remote`/`remove-remote`, resolver union,
   spawn-feed, tests (shape + resolve).
4. **`slice/mcp-tab`** — MCP tab UI: catalog browse + connect + add-remote in-browser.
5. **`slice/mcp-legacy-removal`** — delete `mc integration`, integration columns/enums, chips. Can
   slot 2nd (clears the dual meaning early); independent otherwise.

## Testing

- **Resolver:** composio-only, remote-only, mixed, and collision (profile wins) cases — extend
  `test/composio-mcp-resolve.test.ts`.
- **Remote shape:** `add-remote` row → `{type:'http',url,headers}` with placeholders preserved.
- **Catalog:** `listToolkits` / `listToolkitTools` parse Composio responses (mocked fetch).
- **Legacy removal:** task CRUD still passes with `kind` collapsed; `mc enums` no longer lists
  integration types.
- Tests hit the real Neon dev branch (per repo convention); guard migrations for both `mc_agent` and
  the dropped `cc_agent` grant names.

## Open items to validate during planning (not blockers)

- Exact Composio response shapes for `GET /api/v3/toolkits` (catalog list + pagination/search) and
  `GET /api/v3/tools?toolkit_slug=<slug>`.
- Whether `createMcpServer` accepts an **empty `allowed_tools`** as "all tools" (would let slice 2
  skip per-toolkit tool fetches).
- Whether Composio can expose a **single aggregate MCP endpoint** across a project's connected
  toolkits (would simplify the resolver) — vs. today's per-toolkit URL. Default assumption:
  per-toolkit, unchanged.
- Which task code reads `tasks.kind` (determines whether the column is dropped or pinned in slice 5).

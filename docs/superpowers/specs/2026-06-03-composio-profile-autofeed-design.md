# Composio Profile Auto-Feed — Design Spec

**Slice 4 of the Composio Integrations reshape.** Date: 2026-06-03.

## Goal

A project's **ACTIVE** Composio connections automatically become the `mcpServers` a
spawned agent inherits, so auto-claim and scheduled check-in agents gain the connected
tools (Linear, Slack, …) with no per-profile MCP wiring. This is the payoff slice: slices
1–3 proved the transport, stored connections, and gave operators a UI to connect; slice 4
makes those connections actually reach the agents that run in the project.

## Background (what already exists)

- **Slice 1** proved the `claude` CLI accepts Composio's remote-`http` MCP shape with an
  `x-api-key` header (`{type:'http', url, headers:{'x-api-key':'${COMPOSIO_API_KEY}'}}`).
- **Slice 2** stored per-project connections: `composio_connections` (one per
  project+toolkit; holds `userId = mc-proj-<projectId>`, `toolkitSlug`, `status`,
  `connectedAccountId` — never a secret) and the `composio_toolkits` cache (per toolkit;
  holds `mcpUrl`, the base `https://backend.composio.dev/v3/mcp/<id>`).
- **Slice 3** gave the Integrations tab a live connect/disconnect UI over that lifecycle.
- **The spawn seam** already resolves MCP config: both daemons call
  `spawnExecutor({prompt, runId, repoPath, profile, …})`, and at `daemon/runner.ts:156`
  that runs `resolveMcpConfigJson(profile.mcpServers, process.env)` → 0600 temp file →
  `claude --mcp-config --strict-mcp-config`. `${ENV}` placeholders in `env`/`headers`
  resolve from the daemon's own environment at spawn (the secret never lands in argv).

Slice 4 adds **no transport, no schema, no migration** — it computes the MCP server map
from live connection rows and merges it into that existing seam.

## Decisions (confirmed with the operator)

1. **DB access pattern:** a new `mc composio mcp-config <slug>` CLI command. The daemons
   touch the DB **only** through the `mc` CLI so `mc_agent` scoping stays at the CLI
   boundary; a direct `lib/*-store` import would query Neon via the daemon's own
   `DATABASE_URL` and bypass that scoping. The CLI boundary is the security boundary.
2. **Key-collision precedence:** the **profile's** explicit `mcpServers` entry wins; the
   auto-fed entry for that key is skipped. Explicit > implicit — no silent override of
   hand-authored config.
3. **No-profile scope:** auto-feed applies **only when a profile resolved**. The
   null-profile branch (`planSpawn` with `profile === null`) stays byte-for-byte
   back-compat. In practice there is a default profile, so this is the common path.

## Architecture

Five small units; one new file. No file exceeds one clear responsibility.

### 1. `lib/composio-mcp.ts` (new) — pure builder

```ts
import type { McpServerConfig } from './db/schema';

/** Stable mcpServers key for a toolkit. Matches the slice-1 proof's "composio-linear". */
export function composioServerKey(toolkitSlug: string): string;

/** Build the mcpServers map from already-joined active-connection rows. Pure: no DB, no
 *  network. Each row → one http server entry with the ${COMPOSIO_API_KEY} placeholder
 *  (unresolved — the daemon resolves it at spawn). */
export function buildConnectionMcpServers(
  rows: { toolkitSlug: string; userId: string; mcpUrl: string }[],
): Record<string, McpServerConfig>;
```

Each row yields:

```ts
{
  [composioServerKey(toolkitSlug)]: {
    type: 'http',
    url: `${mcpUrl}?user_id=${encodeURIComponent(userId)}`,
    headers: { 'x-api-key': '${COMPOSIO_API_KEY}' },
  }
}
```

`mcpUrl` is the bare base (no query string), so appending `?user_id=` is safe. Mirrors
slice-3's pure `composio-view.ts` overlay.

### 2. `lib/composio-connections.ts` (+1 function) — orchestration

```ts
/** Resolve a project's ACTIVE Composio connections into an mcpServers map. Looks up the
 *  project, lists its connections, keeps only status==='active', joins each toolkit's
 *  cached mcpUrl, and builds the map. An active connection whose toolkit cache row has no
 *  mcpUrl is skipped (defensive — ensureToolkit populates it before connect). */
export async function resolveProjectMcpServers(
  projectSlug: string,
): Promise<Record<string, McpServerConfig>>;
```

Composes `getProjectIdBySlug` + `listConnectionsByProject` + `getToolkitRow` (per distinct
active toolkit) + `buildConnectionMcpServers`. Throws `NotFoundError('project', slug)` for
an unknown slug (consistent with the sibling functions).

### 3. `cli/index.ts` (+1 command) — `mc composio mcp-config <slug>`

- Readonly. Emits `{"ok":true,"command":"composio mcp-config","data":{"mcpServers":{…}}}`.
- Output carries the **unresolved** `${COMPOSIO_API_KEY}` placeholder — the CLI never emits
  the secret.
- New entry in the `SPEC` array (readonly: true) keeps `test/spec-sync.test.ts` green.

### 4. `daemon/render-profile.ts` (+1 function) — merge helper

```ts
/** Merge auto-fed MCP servers UNDER a profile's own. Spreading `extra` first then `base`
 *  makes the profile (base) win on a key collision (decision 2). Returns the profile's map
 *  unchanged when there is nothing extra, and null only when both are empty. */
export function mergeMcpServers(
  base: Record<string, McpServerConfig> | null | undefined,
  extra: Record<string, McpServerConfig> | null | undefined,
): Record<string, McpServerConfig> | null;
```

Lives here (not in `composio-mcp.ts`) because it is a generic MCP-config concern alongside
`resolveMcpConfigJson`, and is composio-agnostic.

### 5. `daemon/runner.ts` + callers — wiring

- `SpawnExecutorOpts` gains `extraMcpServers?: Record<string, McpServerConfig>`.
- The seam at `runner.ts:156` becomes:

  ```ts
  const mcpJson = profile
    ? resolveMcpConfigJson(mergeMcpServers(profile.mcpServers, opts.extraMcpServers), process.env)
    : null;
  ```

  Keeping the `profile ?` guard honors decision 3: with no profile, `extraMcpServers` is
  ignored and the back-compat spawn is unchanged.
- **`daemon/auto-claim.ts`** and **`daemon/scheduler.ts`**: when a profile resolved, fetch
  `mc(['composio', 'mcp-config', slug])` and pass `extraMcpServers: data.mcpServers` into
  `spawnExecutor`. A fetch failure is **non-fatal** — log and spawn without auto-feed
  (mirrors the existing `resolveProfileForTask` fallback so a DB blip never blocks the
  queue). When non-empty, log `fed N composio server(s) [linear, slack] into run <id>`.

## Data flow (per spawn)

```
auto-claim / scheduler  ──(profile resolved)──>  mc composio mcp-config <slug>
   │                                                  │  active connections + toolkit mcpUrls
   │   <── {mcpServers:{composio-linear:{…}}} ────────┘  (placeholder, no secret)
   ▼
spawnExecutor({ …, extraMcpServers })
   └─ mergeMcpServers(profile.mcpServers, extra)        // profile wins collisions
      └─ resolveMcpConfigJson(merged, process.env)      // ${COMPOSIO_API_KEY} resolved HERE
         └─ 0600 temp file → claude --mcp-config --strict-mcp-config
```

## Error handling

- **Project not found** → CLI exit 3 / `NOT_FOUND`. **No active connections** →
  `{mcpServers:{}}`; `mergeMcpServers` is a no-op and the spawn is unchanged.
- **Active connection missing `mcpUrl`** (cache row absent) → that toolkit is skipped; the
  command still returns the others. Defensive only — `ensureToolkit` populates the cache
  before any connection is written.
- **`mc composio mcp-config` fails transiently** → non-fatal in the daemon: log and spawn
  without auto-feed; the queue keeps moving.
- **`COMPOSIO_API_KEY` unset in the daemon env while active connections exist** →
  `resolveMcpConfigJson` throws `MissingEnvError` naming the var → the caller's existing
  catch fails **that** run cleanly with a clear message. **Fail-closed by design** —
  identical to how a profile's own secret-bearing server behaves today, and the key is
  already a documented daemon-launch requirement.

## Testing

- `test/composio-mcp.test.ts` — pure: active-only filter, URL construction
  (`?user_id=`, encoding), `composio-<slug>` key, skip-no-`mcpUrl`, empty input; plus
  `mergeMcpServers` precedence (profile wins / union / both-empty → null).
- Real-Neon test — `resolveProjectMcpServers` and the `mc composio mcp-config` envelope:
  seed a project + toolkit cache row + active/non-active connection rows, assert the
  resolved map; self-cleaning throwaway rows (per the repo's test convention).
- `render-profile` — a merged map resolves the `${COMPOSIO_API_KEY}` placeholder
  end-to-end via `resolveMcpConfigJson`.
- **Manual smoke (live-validate, like slice 1):** a profiled auto-claim run on a project
  with an active Linear connection; confirm the agent has the Linear tools.
  `MC_DAEMON_EXEC` short-circuits before the MCP seam, so a real spawn is the only true
  end-to-end check — hence a smoke, not a unit test.

## Out of scope (deferred)

- A shared `ConnectionStatus` type from `lib/db/schema.ts` (we filter on the
  `status==='active'` string here).
- Auto-feed for the null-profile back-compat spawn.
- OAuth token-expiry / re-auth automation; orphaned-account cleanup; multiple accounts per
  (project, toolkit).

## Files

- **New:** `lib/composio-mcp.ts`, `test/composio-mcp.test.ts` (+ a real-Neon resolve/CLI test).
- **Modified:** `lib/composio-connections.ts`, `cli/index.ts`, `daemon/render-profile.ts`,
  `daemon/runner.ts`, `daemon/auto-claim.ts`, `daemon/scheduler.ts`.
- No schema change, no migration.

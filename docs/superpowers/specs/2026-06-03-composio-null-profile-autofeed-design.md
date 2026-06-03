# Composio Null-Profile Auto-Feed — Design Spec

**Deferred item #3 of the Composio Integrations reshape.** Date: 2026-06-03.

## Goal

A **profileless** auto-claim spawn (`planSpawn` with `profile === null`) inherits the
project's **ACTIVE** Composio connections as `mcpServers`, just like a profiled spawn does
since slice 4 (PR #11). The secret-resolution and fail-closed guarantees from slice 4 are
preserved unchanged.

## Background (what already exists)

Slice 4 added project→MCP auto-feed, but deliberately scoped it to the profiled path
(decision 3 of its spec): "auto-feed applies only when a profile resolved." Three aligned
guards enforce that today:

1. **`daemon/auto-claim.ts`** — fetches connections only `if (profile)`:
   `const extraMcpServers = profile ? await fetchComposioMcpServers(...) : undefined;`
2. **`daemon/runner.ts:175`** (the spawn seam) — resolves the MCP JSON only for a profile:
   `const mcpJson = profile ? resolveMcpConfigJson(mergeMcpServers(profile.mcpServers, opts.extraMcpServers), process.env) : null;`
3. **`daemon/render-profile.ts:143`** (`planSpawn`'s null branch) — builds its argv with
   **no** `--mcp-config` flag at all (the historical back-compat invocation).

The scheduler is unaffected: `runCheckIn` always resolves a profile, so its spawns never
hit the null branch. Only the auto-claim path can spawn profileless (no matching rule and
no default profile).

## Decision (confirmed with the operator)

**MCP scope for the null-profile spawn: strict — Composio only.** The profileless spawn is
rendered with `--mcp-config <temp> --strict-mcp-config`, exactly like the profile path. The
agent sees the project's active Composio servers and nothing else (no host `~/.claude.json`
/ project `.mcp.json` bleed-in). Rationale: one consistent mental model, reproducible, no
host bleed-in — matching the security posture used everywhere else. This changes back-compat
behavior **only when active connections exist** (host MCP becomes unavailable for that
spawn); with zero connections, no `--mcp-config` is added and the spawn is byte-for-byte the
historical invocation.

## Architecture

No new files, no schema, no migration. Three small edits drop the three aligned guards so
the existing slice-4 machinery runs for the null-profile case too. Because
`mergeMcpServers(undefined, undefined)` already returns `null`, removing the guards is
back-compat-safe: a project with no active connections produces no `--mcp-config` and an
unchanged spawn.

### 1. `daemon/runner.ts` — the spawn seam (1 line + comment)

```ts
// was: const mcpJson = profile ? resolveMcpConfigJson(mergeMcpServers(profile.mcpServers, opts.extraMcpServers), process.env) : null;
const mcpJson = resolveMcpConfigJson(mergeMcpServers(profile?.mcpServers, opts.extraMcpServers), process.env);
```

`profile?.mcpServers` is `undefined` when there is no profile; `mergeMcpServers(undefined,
extra)` returns just `extra` (or `null` when that is empty too). The `extraMcpServers` doc
comment on `SpawnExecutorOpts` loses its "Ignored when there is no profile" clause.

### 2. `daemon/render-profile.ts` — `planSpawn` null branch (+2 argv entries)

The null branch appends `--mcp-config <mcpConfigPath> --strict-mcp-config` **when
`mcpConfigPath` is set**, and is otherwise unchanged:

```ts
if (!profile) {
  const args = ['-p', prompt, '--permission-mode', basePermissionMode, '--output-format', 'json'];
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
  return { runtime: 'claude-code', bin: claudeBin, args, extraEnv: {} };
}
```

The back-compat comment is updated: "…reproduces the historical invocation byte-for-byte
when no servers are auto-fed; with auto-fed servers it adds `--mcp-config` like the profile
path."

### 3. `daemon/auto-claim.ts` — drop the fetch guard (1 line)

```ts
// was: const extraMcpServers = profile ? await fetchComposioMcpServers(a.project, runId, log) : undefined;
const extraMcpServers = await fetchComposioMcpServers(a.project, runId, log);
```

The adjacent comment (currently "Auto-feed the project's ACTIVE Composio connections as MCP
servers (profileless spawns skip it).") drops its parenthetical. A profileless spawn now
fetches the project's connections like a profiled one. The shared `fetchComposioMcpServers`
already logs `fed N composio server(s) […]` and returns `undefined` on a (non-fatal) CLI
failure. The existing try/catch around `spawnExecutor` in auto-claim (which fails the run
cleanly on a render throw) already covers the inherited `MissingEnvError` fail-closed path.

## Data flow (per profileless spawn)

```
auto-claim (profile === null)  ──>  mc composio mcp-config <slug>
   │                                    │  active connections + toolkit mcpUrls
   │   <── {mcpServers:{composio-linear:{…}}} ──┘  (placeholder, no secret)
   ▼
spawnExecutor({ …, profile: null, extraMcpServers })
   └─ mergeMcpServers(undefined, extra)            // = extra (Composio only)
      └─ resolveMcpConfigJson(merged, process.env) // ${COMPOSIO_API_KEY} resolved HERE
         └─ 0600 temp file → planSpawn(null) → claude … --mcp-config --strict-mcp-config
```

## Error handling (fully inherited from slice 4)

- **`COMPOSIO_API_KEY` unset while active connections exist** → `resolveMcpConfigJson`
  throws `MissingEnvError` (it runs at the seam, before the spawn try-block) → the caller
  fails that run cleanly with a clear message. **Fail-closed, identical to the profile
  path.**
- **`mc composio mcp-config` fails transiently** → non-fatal: `fetchComposioMcpServers`
  logs and returns `undefined` → spawn without auto-feed, queue keeps moving.
- **No active connections** → `{mcpServers:{}}` → `mergeMcpServers` is `null` → no
  `--mcp-config`, byte-for-byte historical spawn.

## Testing

- **`test/daemon-render.test.ts` (pure — the real gate):**
  - `planSpawn(null, { …, mcpConfigPath: '/tmp/x' })` → argv contains `--mcp-config /tmp/x
    --strict-mcp-config`.
  - `planSpawn(null, { …, mcpConfigPath: null })` → argv is exactly
    `['-p', prompt, '--permission-mode', mode, '--output-format', 'json']` (explicit
    back-compat assertion — no `--mcp-config`).
  - The seam's guard removal is already covered by existing `mergeMcpServers`
    (`mergeMcpServers(undefined, {x})` → `{x}`; `(undefined, undefined)` → `null`) and
    `resolveMcpConfigJson` tests.
- **Manual smoke (live-validate):** with no default profile set and no matching rule (so
  `resolveProfileForTask` returns `null`), run auto-claim `--once` on a project with an
  active Linear connection. Confirm the `fed 1 composio server(s) [linear]` log fires for
  the profileless run *and* the rendered argv carries `--mcp-config`. Reaching the null
  branch requires temporarily clearing the default profile, since `mc profile set-default`
  otherwise always supplies one.

## Out of scope (still deferred — separate slices)

- Orphaned-account cleanup on reconnect (#5).
- OAuth token-expiry / re-auth automation (#4).
- Multiple accounts per (project, toolkit) (#6).

## Files

- **Modified:** `daemon/runner.ts`, `daemon/render-profile.ts`, `daemon/auto-claim.ts`,
  `test/daemon-render.test.ts`.
- No new files, no schema change, no migration.

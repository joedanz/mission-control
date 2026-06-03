# Composio Profile Auto-Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project's ACTIVE Composio connections automatically become the `mcpServers` a spawned agent (auto-claim / scheduled check-in) inherits.

**Architecture:** A pure builder turns active-connection rows into an `mcpServers` map; orchestration in `lib/composio-connections.ts` joins the DB rows; a readonly `mc composio mcp-config <slug>` CLI command exposes it (keeping all DB access at the `mc_agent` CLI boundary); the daemons fetch it and merge it UNDER the profile's own servers (profile wins collisions) at the existing `runner.ts` MCP seam. No schema, no migration.

**Tech Stack:** TypeScript, Drizzle ORM + Neon Postgres, Vitest (pure tests + real-Neon self-cleaning tests), Commander CLI.

**Spec:** `docs/superpowers/specs/2026-06-03-composio-profile-autofeed-design.md`

**Branch:** `slice/composio-profile-autofeed` (already created).

---

## Conventions for this repo (read before starting)

- **Lint changed files explicitly:** `npx eslint <paths>` — `npm run lint` is a broken no-op gate (it walks `docs/dist` build artifacts, crashes the formatter, and exits 0). The config enforces React-Compiler `react-hooks/*` rules (not relevant to this slice — no React here).
- **Tests run against real Neon.** `vitest.config.ts` loads `.env.local`, `fileParallelism:false`; real-DB tests use throwaway rows and self-clean in `afterEach`. No migration is needed for this slice (no schema change).
- **Run a single test file:** `npx vitest run test/<file>.test.ts`.
- **Typecheck:** `npx tsc --noEmit`.
- The `McpServerConfig` type is exported from `lib/db/schema.ts`:
  `{ type?: 'stdio'|'http'|'sse'|'ws'; command?; args?; url?; env?; headers? }`.

---

## File Structure

- **Create:** `lib/composio-mcp.ts` — pure builder (`composioServerKey`, `buildConnectionMcpServers`).
- **Create:** `test/composio-mcp.test.ts` — pure builder tests.
- **Create:** `test/composio-mcp-resolve.test.ts` — real-Neon `resolveProjectMcpServers` test.
- **Modify:** `daemon/render-profile.ts` — add `mergeMcpServers`.
- **Modify:** `test/daemon-render.test.ts` — add `mergeMcpServers` tests.
- **Modify:** `lib/composio-connections.ts` — add `resolveProjectMcpServers`.
- **Modify:** `cli/index.ts` — add `composio mcp-config` command + its SPEC entry.
- **Modify:** `daemon/runner.ts` — `SpawnExecutorOpts.extraMcpServers` + merge at the seam.
- **Modify:** `daemon/auto-claim.ts` — fetch + pass `extraMcpServers`.
- **Modify:** `daemon/scheduler.ts` — fetch + pass `extraMcpServers`.
- **Modify:** `docs/runbooks/composio-linear-smoke.md` — add the auto-feed smoke section.

---

## Task 1: Pure builder (`lib/composio-mcp.ts`)

**Files:**
- Create: `lib/composio-mcp.ts`
- Test: `test/composio-mcp.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/composio-mcp.test.ts`:

```ts
// ABOUTME: Pure tests for the Composio mcpServers builder — key naming, URL construction, encoding.

import { describe, it, expect } from 'vitest';
import { composioServerKey, buildConnectionMcpServers } from '../lib/composio-mcp';

describe('composioServerKey', () => {
  it('prefixes the toolkit slug', () => {
    expect(composioServerKey('linear')).toBe('composio-linear');
  });
});

describe('buildConnectionMcpServers (pure)', () => {
  it('builds an http server with a user_id query + api-key placeholder', () => {
    const map = buildConnectionMcpServers([
      { toolkitSlug: 'linear', userId: 'mc-proj-abc', mcpUrl: 'https://backend.composio.dev/v3/mcp/srv1' },
    ]);
    expect(map).toEqual({
      'composio-linear': {
        type: 'http',
        url: 'https://backend.composio.dev/v3/mcp/srv1?user_id=mc-proj-abc',
        headers: { 'x-api-key': '${COMPOSIO_API_KEY}' },
      },
    });
  });

  it('emits one entry per row, keyed by toolkit', () => {
    const map = buildConnectionMcpServers([
      { toolkitSlug: 'linear', userId: 'u1', mcpUrl: 'https://x/v3/mcp/a' },
      { toolkitSlug: 'slack', userId: 'u1', mcpUrl: 'https://x/v3/mcp/b' },
    ]);
    expect(Object.keys(map).sort()).toEqual(['composio-linear', 'composio-slack']);
  });

  it('url-encodes the user_id', () => {
    const map = buildConnectionMcpServers([{ toolkitSlug: 'linear', userId: 'a/b c', mcpUrl: 'https://x/v3/mcp/a' }]);
    expect(map['composio-linear'].url).toBe('https://x/v3/mcp/a?user_id=a%2Fb%20c');
  });

  it('returns an empty map for no rows', () => {
    expect(buildConnectionMcpServers([])).toEqual({});
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/composio-mcp.test.ts`
Expected: FAIL — `Cannot find module '../lib/composio-mcp'`.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/composio-mcp.ts`:

```ts
// ABOUTME: Pure builder that turns a project's active Composio connections into an mcpServers map for
// ABOUTME: a spawned agent. No DB, no network — the DB join lives in composio-connections.ts.

import type { McpServerConfig } from './db/schema';

/** Stable mcpServers key for a toolkit (matches the slice-1 proof's "composio-linear"). */
export function composioServerKey(toolkitSlug: string): string {
  return `composio-${toolkitSlug}`;
}

/** Build the mcpServers map from already-joined active-connection rows. Each row → one http server
 *  entry carrying the ${COMPOSIO_API_KEY} placeholder (the daemon resolves it at spawn, never here).
 *  The caller passes ONLY the rows it wants emitted (active, with a known mcpUrl). */
export function buildConnectionMcpServers(
  rows: { toolkitSlug: string; userId: string; mcpUrl: string }[],
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const { toolkitSlug, userId, mcpUrl } of rows) {
    out[composioServerKey(toolkitSlug)] = {
      type: 'http',
      url: `${mcpUrl}?user_id=${encodeURIComponent(userId)}`,
      headers: { 'x-api-key': '${COMPOSIO_API_KEY}' },
    };
  }
  return out;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run test/composio-mcp.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint lib/composio-mcp.ts test/composio-mcp.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/composio-mcp.ts test/composio-mcp.test.ts
git commit -m "feat: pure Composio mcpServers builder (composio-mcp.ts)"
```

---

## Task 2: Merge helper (`mergeMcpServers` in `daemon/render-profile.ts`)

**Files:**
- Modify: `daemon/render-profile.ts` (add `mergeMcpServers` after `resolveMcpConfigJson`, ~line 65)
- Test: `test/daemon-render.test.ts` (add a `describe` block; extend the import from `../daemon/render-profile`)

- [ ] **Step 1: Write the failing test**

In `test/daemon-render.test.ts`, add `mergeMcpServers` to the existing import from `'../daemon/render-profile'`, add `McpServerConfig` to the existing `import type { AgentProfile } from '../lib/db/schema'` line (making it `import type { AgentProfile, McpServerConfig } from '../lib/db/schema'`), and append this block:

```ts
describe('mergeMcpServers (pure)', () => {
  const a: McpServerConfig = { type: 'http', url: 'https://a' };
  const b: McpServerConfig = { type: 'http', url: 'https://b' };

  it('returns null when both are empty', () => {
    expect(mergeMcpServers(null, null)).toBeNull();
    expect(mergeMcpServers({}, {})).toBeNull();
  });

  it('passes a base (profile) map through when there is no extra', () => {
    expect(mergeMcpServers({ gh: a }, null)).toEqual({ gh: a });
  });

  it('unions disjoint keys', () => {
    expect(mergeMcpServers({ gh: a }, { 'composio-linear': b })).toEqual({ gh: a, 'composio-linear': b });
  });

  it('profile (base) wins a key collision', () => {
    expect(mergeMcpServers({ 'composio-linear': a }, { 'composio-linear': b })).toEqual({ 'composio-linear': a });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/daemon-render.test.ts`
Expected: FAIL — `mergeMcpServers is not exported` / `is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `daemon/render-profile.ts`, immediately after the `resolveMcpConfigJson` function (the line `}` closing it at ~line 65), add:

```ts
/** Merge auto-fed MCP servers UNDER a profile's own. Spreading `extra` first then `base` makes the
 *  profile (base) win on a key collision. Returns null only when the merge is empty, so the caller can
 *  treat null as "no --mcp-config" exactly like a profile with no servers. */
export function mergeMcpServers(
  base: Record<string, McpServerConfig> | null | undefined,
  extra: Record<string, McpServerConfig> | null | undefined,
): Record<string, McpServerConfig> | null {
  const merged = { ...(extra ?? {}), ...(base ?? {}) };
  return Object.keys(merged).length ? merged : null;
}
```

(`McpServerConfig` is already imported at the top of `render-profile.ts`.)

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run test/daemon-render.test.ts`
Expected: PASS (existing tests + 4 new).

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint daemon/render-profile.ts test/daemon-render.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add daemon/render-profile.ts test/daemon-render.test.ts
git commit -m "feat: mergeMcpServers — profile wins key collisions"
```

---

## Task 3: Orchestration (`resolveProjectMcpServers` in `lib/composio-connections.ts`)

**Files:**
- Modify: `lib/composio-connections.ts` (add a function + imports)
- Test: `test/composio-mcp-resolve.test.ts` (new, real Neon)

- [ ] **Step 1: Write the failing test**

Create `test/composio-mcp-resolve.test.ts`:

```ts
// ABOUTME: resolveProjectMcpServers against real Neon — active connections join the toolkit mcpUrl;
// ABOUTME: non-active rows are excluded. Self-cleaning throwaway rows (uses random toolkit slugs so it
// ABOUTME: never mutates the real linear/slack cache rows in the shared DB).

import { describe, it, expect, afterEach } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, composioToolkits } from '../lib/db/schema';
import { createProject } from '../lib/mutations';
import { upsertToolkitRow, upsertConnection } from '../lib/composio-store';
import { resolveProjectMcpServers } from '../lib/composio-connections';

const projectIds: string[] = [];
const toolkitSlugs: string[] = [];
const tag = () => `vt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

afterEach(async () => {
  if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds)); // cascades connections
  if (toolkitSlugs.length) await db.delete(composioToolkits).where(inArray(composioToolkits.slug, toolkitSlugs));
  projectIds.length = 0;
  toolkitSlugs.length = 0;
});

describe('resolveProjectMcpServers (real Neon)', () => {
  it('maps only ACTIVE connections, joining the toolkit mcpUrl', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    const lin = tag();
    const sla = tag();
    toolkitSlugs.push(lin, sla);
    await upsertToolkitRow(lin, { mcpUrl: `https://x/v3/mcp/${lin}` });
    await upsertToolkitRow(sla, { mcpUrl: `https://x/v3/mcp/${sla}` });
    await upsertConnection(p.id, lin, { userId: `mc-proj-${p.id}`, status: 'active', connectedAccountId: 'ca_1' });
    await upsertConnection(p.id, sla, { userId: `mc-proj-${p.id}`, status: 'initializing', connectedAccountId: 'ca_2' });

    const map = await resolveProjectMcpServers(p.slug);

    expect(Object.keys(map)).toEqual([`composio-${lin}`]); // the initializing one is excluded
    expect(map[`composio-${lin}`].url).toBe(`https://x/v3/mcp/${lin}?user_id=mc-proj-${p.id}`);
    expect(map[`composio-${lin}`].headers?.['x-api-key']).toBe('${COMPOSIO_API_KEY}');
  });

  it('skips an active connection whose toolkit cache row has no mcpUrl', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    const lin = tag();
    toolkitSlugs.push(lin);
    // toolkit cache row exists but has no mcpUrl yet
    await upsertToolkitRow(lin, { authConfigId: 'ac_x' });
    await upsertConnection(p.id, lin, { userId: `mc-proj-${p.id}`, status: 'active', connectedAccountId: 'ca_1' });

    expect(await resolveProjectMcpServers(p.slug)).toEqual({});
  });

  it('returns an empty map for a project with no active connections', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    expect(await resolveProjectMcpServers(p.slug)).toEqual({});
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/composio-mcp-resolve.test.ts`
Expected: FAIL — `resolveProjectMcpServers is not exported` / `is not a function`.

- [ ] **Step 3: Write the minimal implementation**

In `lib/composio-connections.ts`:

(a) `getToolkitRow` and `listConnectionsByProject` are already imported from `./composio-store`, and `getProjectIdBySlug` / `NotFoundError` are already imported — no change to those.

(b) Add `McpServerConfig` to the existing schema type import. Change the current line:

```ts
import type { ComposioConnection } from './db/schema';
```

to:

```ts
import type { ComposioConnection, McpServerConfig } from './db/schema';
```

(c) Add the builder import alongside the other `./composio-*` imports at the top:

```ts
import { buildConnectionMcpServers } from './composio-mcp';
```

(d) Append this function at the end of the file:

```ts
/** Resolve a project's ACTIVE Composio connections into an mcpServers map for a spawned agent. Lists
 *  the project's connections, keeps only status==='active', joins each toolkit's cached mcpUrl, and
 *  builds the map. An active connection whose toolkit cache row has no mcpUrl is skipped (defensive —
 *  ensureToolkit populates it before connect). */
export async function resolveProjectMcpServers(projectSlug: string): Promise<Record<string, McpServerConfig>> {
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  const active = (await listConnectionsByProject(projectId)).filter((c) => c.status === 'active');
  const rows: { toolkitSlug: string; userId: string; mcpUrl: string }[] = [];
  for (const c of active) {
    const toolkit = await getToolkitRow(c.toolkitSlug);
    if (toolkit?.mcpUrl) rows.push({ toolkitSlug: c.toolkitSlug, userId: c.userId, mcpUrl: toolkit.mcpUrl });
  }
  return buildConnectionMcpServers(rows);
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run test/composio-mcp-resolve.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint lib/composio-connections.ts test/composio-mcp-resolve.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add lib/composio-connections.ts test/composio-mcp-resolve.test.ts
git commit -m "feat: resolveProjectMcpServers — active connections → mcpServers map"
```

---

## Task 4: CLI command (`mc composio mcp-config <slug>`)

**Files:**
- Modify: `cli/index.ts` (add the SPEC entry ~line 335; add the command ~line 929, after `composio disconnect`)
- Test: `test/spec-sync.test.ts` (no edit — it must stay green after adding both the SPEC entry and the command)

- [ ] **Step 1: Add the SPEC entry**

In `cli/index.ts`, in the `SPEC` array, immediately after the `composio disconnect` entry (currently ~line 335), add:

```ts
  { name: 'composio mcp-config', readonly: true, summary: "Resolve a project's active connections into an mcpServers map", args: ['<slug>'] },
```

- [ ] **Step 2: Run spec-sync to verify it now FAILS (command registered ≠ SPEC)**

Run: `npx vitest run test/spec-sync.test.ts`
Expected: FAIL — SPEC lists `composio mcp-config` but no such leaf command is registered yet.

- [ ] **Step 3: Add the command**

In `cli/index.ts`, immediately after the `composio disconnect` command block (the `.action(...)` ending ~line 929), add:

```ts
withFlags(composio.command('mcp-config'))
  .description("Resolve a project's active connections into an mcpServers map (placeholder secrets)")
  .argument('<slug>')
  .action((slug: string, opts: LeafOpts) =>
    emit('composio mcp-config', opts, async () => {
      ensureDbCredentials();
      const { resolveProjectMcpServers } = await import('../lib/composio-connections');
      const mcpServers = await resolveProjectMcpServers(slug);
      return {
        data: { mcpServers },
        human: () => {
          const keys = Object.keys(mcpServers);
          console.log(keys.length ? keys.join('\n') : '(no active connections)');
        },
      };
    }),
  );
```

- [ ] **Step 4: Run spec-sync to verify it PASSES**

Run: `npx vitest run test/spec-sync.test.ts`
Expected: PASS — SPEC and registered leaf commands match again.

- [ ] **Step 5: Smoke the command shape against real Neon (manual, non-destructive)**

Run (any existing project slug — use one from `npm run cli -- project list`):

```bash
npm run cli -- composio mcp-config bodybymike --json
```

Expected: a `{"ok":true,"command":"composio mcp-config","data":{"mcpServers":{…}}}` envelope. If the project has an active connection, its `url` contains `?user_id=mc-proj-…` and the header value is the literal `${COMPOSIO_API_KEY}` (no secret). An unknown slug → `{"ok":false,...,"error":{"code":"NOT_FOUND",...}}` with exit code 3.

- [ ] **Step 6: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint cli/index.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add cli/index.ts
git commit -m "feat: mc composio mcp-config — expose a project's active-connection mcpServers"
```

---

## Task 5: Daemon wiring (`runner.ts` + both callers)

**Files:**
- Modify: `daemon/runner.ts` (import `mergeMcpServers` + `McpServerConfig`; add `extraMcpServers` to `SpawnExecutorOpts`; merge at the seam ~line 156)
- Modify: `daemon/auto-claim.ts` (fetch + pass `extraMcpServers`)
- Modify: `daemon/scheduler.ts` (fetch + pass `extraMcpServers`)

This task has no new unit test (the `MC_DAEMON_EXEC` stub short-circuits `spawnExecutor` before the MCP seam, so the merge path isn't reachable from a stubbed spawn; its pieces — `mergeMcpServers`, `resolveProjectMcpServers` — are already covered by Tasks 2–3, and the true end-to-end is the Task 6 smoke). Verify with typecheck + the full suite.

- [ ] **Step 1: Wire `runner.ts`**

(a) Change the import on line 12 from:

```ts
import { planSpawn, resolveMcpConfigJson, type ModelChoice } from './render-profile';
```

to:

```ts
import { planSpawn, resolveMcpConfigJson, mergeMcpServers, type ModelChoice } from './render-profile';
```

(b) Add `McpServerConfig` to the schema type import on line 11 — change:

```ts
import type { AgentProfile } from '../lib/db/schema';
```

to:

```ts
import type { AgentProfile, McpServerConfig } from '../lib/db/schema';
```

(c) In the `SpawnExecutorOpts` type (ends ~line 131), add this field after `extraAllowedTools?: string[];`:

```ts
  /** Project-derived Composio MCP servers (from `mc composio mcp-config`), merged UNDER the profile's
   *  own mcpServers (the profile wins a key collision). Ignored when there is no profile. */
  extraMcpServers?: Record<string, McpServerConfig>;
```

(d) Change the MCP-resolve seam (currently line 156):

```ts
  const mcpJson = profile ? resolveMcpConfigJson(profile.mcpServers, process.env) : null;
```

to:

```ts
  const mcpJson = profile ? resolveMcpConfigJson(mergeMcpServers(profile.mcpServers, opts.extraMcpServers), process.env) : null;
```

- [ ] **Step 2: Wire `auto-claim.ts`**

(a) Add `McpServerConfig` to the schema type import on line 17 — change:

```ts
import type { AgentProfile } from '../lib/db/schema';
```

to:

```ts
import type { AgentProfile, McpServerConfig } from '../lib/db/schema';
```

(b) In `processNext`, immediately after the `if (choice.downgraded) await recordDowngrade(...)` line (currently line 117) and before the `const how = ...` line, insert the fetch:

```ts
  // Auto-feed: a project's ACTIVE Composio connections become MCP servers this agent inherits. Fetch via
  // the CLI (DB scope stays at the mc_agent boundary). Non-fatal — a blip just spawns without auto-feed.
  let extraMcpServers: Record<string, McpServerConfig> | undefined;
  if (profile) {
    const cfg = await mc(['composio', 'mcp-config', a.project]);
    if (cfg.ok) {
      extraMcpServers = (cfg.data as { mcpServers?: Record<string, McpServerConfig> } | null)?.mcpServers;
      const keys = Object.keys(extraMcpServers ?? {});
      if (keys.length) log(`fed ${keys.length} composio server(s) [${keys.map((k) => k.replace('composio-', '')).join(', ')}] into run ${runId.slice(0, 8)}`);
    } else {
      log(`composio mcp-config for ${a.project} failed (${cfg.error?.code ?? cfg.code}) — spawning without auto-feed`);
    }
  }
```

(c) Add `extraMcpServers` to the `spawnExecutor({...})` call (currently lines 127-135) — add it to the options object:

```ts
    spawned = spawnExecutor({
      prompt: buildTaskPrompt(task),
      runId,
      repoPath,
      profile,
      effectiveModel: choice.model,
      basePermissionMode: a.permissionMode,
      extraEnv: { MC_TASK_LABEL: task.label, MC_TASK_NOTES: task.notes ?? '' },
      extraMcpServers,
    });
```

- [ ] **Step 3: Wire `scheduler.ts`**

(a) Confirm the schema type import includes `McpServerConfig`. `scheduler.ts` imports `import type { AgentProfile } from '../lib/db/schema';` — change it to:

```ts
import type { AgentProfile, McpServerConfig } from '../lib/db/schema';
```

(b) In `runCheckIn`, immediately after the `if (choice.downgraded) await recordDowngrade(...)` line (currently line 113) and before the `const how = ...` line, insert:

```ts
  // Auto-feed the project's ACTIVE Composio connections (same as auto-claim). Non-fatal on failure.
  let extraMcpServers: Record<string, McpServerConfig> | undefined;
  const cfg = await mc(['composio', 'mcp-config', project.slug]);
  if (cfg.ok) {
    extraMcpServers = (cfg.data as { mcpServers?: Record<string, McpServerConfig> } | null)?.mcpServers;
    const keys = Object.keys(extraMcpServers ?? {});
    if (keys.length) log(`fed ${keys.length} composio server(s) [${keys.map((k) => k.replace('composio-', '')).join(', ')}] into run ${runId.slice(0, 8)}`);
  } else {
    log(`composio mcp-config for ${project.slug} failed (${cfg.error?.code ?? cfg.code}) — spawning without auto-feed`);
  }
```

(The scheduler always spawns with a profile, so there is no `if (profile)` guard here.)

(c) Add `extraMcpServers` to the `spawnExecutor({...})` call (currently line 121):

```ts
    spawned = spawnExecutor({ prompt, runId, repoPath, profile, effectiveModel: choice.model, basePermissionMode: a.permissionMode, extraAllowedTools: CHECK_IN_TOOLS, extraMcpServers });
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the daemon-render + full suite to confirm nothing regressed**

Run: `npx vitest run test/daemon-render.test.ts && npx vitest run`
Expected: PASS (whole suite green).

- [ ] **Step 6: Lint**

Run: `npx eslint daemon/runner.ts daemon/auto-claim.ts daemon/scheduler.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add daemon/runner.ts daemon/auto-claim.ts daemon/scheduler.ts
git commit -m "feat: daemons auto-feed a project's active Composio connections into spawns"
```

---

## Task 6: Smoke runbook section

**Files:**
- Modify: `docs/runbooks/composio-linear-smoke.md`

- [ ] **Step 1: Append the auto-feed smoke section**

Add this section at the end of `docs/runbooks/composio-linear-smoke.md`:

```markdown
## Slice 4 smoke — profile auto-feed (manual)

Proves a project's ACTIVE Composio connection automatically reaches an auto-claimed agent —
no per-profile MCP wiring. `MC_DAEMON_EXEC` short-circuits the spawn before the MCP seam, so
this real spawn is the only true end-to-end check.

Prerequisites:
- A project (e.g. `bodybymike`) with a `repoPath` set and an **active** Linear connection
  (`mc composio list <slug>` shows `linear  active`). Connect via the Integrations tab or
  `mc composio connect <slug> linear` → authorize → `mc composio status <slug> linear`.
- `COMPOSIO_API_KEY` set in the daemon's environment (same requirement as any profile secret).
- A resolvable agent profile for the project (the default profile is fine).

Steps:
1. Confirm the resolved map is non-empty:
   `npm run cli -- composio mcp-config <slug> --json` →
   `data.mcpServers["composio-linear"]` present, `url` ends `?user_id=mc-proj-…`.
2. Queue a task that requires Linear, e.g.:
   `npm run cli -- task add <slug> "List our Linear teams and report their names"`
3. Run one auto-claim pass (permission mode that allows the MCP tool calls):
   `MC_CLAUDE_BIN=/Users/danziger/.local/bin/claude tsx daemon/auto-claim.ts --project <slug> --once --permission-mode acceptEdits`
4. In the daemon log, confirm the line `fed 1 composio server(s) [linear] into run <id>`.
5. Confirm the run output shows the agent listed the Linear teams (it used the auto-fed tool).

Negative check: with no active connection, step 1 returns `{mcpServers:{}}` and the daemon log
shows no `fed … composio server(s)` line — the spawn is unchanged.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/composio-linear-smoke.md
git commit -m "docs: auto-feed smoke section in the Composio Linear runbook"
```

---

## Final verification (after all tasks)

- [ ] `npx tsc --noEmit` — clean.
- [ ] `npx vitest run` — whole suite green.
- [ ] `npx eslint lib/composio-mcp.ts lib/composio-connections.ts cli/index.ts daemon/render-profile.ts daemon/runner.ts daemon/auto-claim.ts daemon/scheduler.ts test/composio-mcp.test.ts test/composio-mcp-resolve.test.ts test/daemon-render.test.ts` — clean.
- [ ] `npm run cli -- composio mcp-config <slug> --json` returns the expected envelope.
- [ ] Dispatch the final whole-feature code review.
- [ ] Run `/simplify` over the branch diff.
- [ ] Then `superpowers:finishing-a-development-branch`.

# MCP Catalog (Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users browse Composio's full live catalog (1043 toolkits) and connect *any* toolkit — not just the hardcoded editorial pair (linear, slack).

**Architecture:** Add a live `listToolkits()` wrapper to the existing Composio v3 client (`lib/composio-api.ts`), back `mc mcp catalog` with it (searchable, no DB), and relax `ensureToolkit` so connecting an uncurated toolkit creates its shared MCP server with `allowed_tools: []` — which Composio expands to **all** of that toolkit's tools (verified live). The curated `COMPOSIO_CATALOG` survives only as the narrow "featured" tool-list for linear/slack and as a `featured` flag in the catalog listing.

**Tech Stack:** TypeScript, Commander CLI (`cli/index.ts`), Vitest (fetch-mocked, CI-safe — no live Composio, no DB for the catalog path).

**Decisions baked in (from the live spike — see `reference_composio_v3_api_shapes` memory):**
- `GET /api/v3/toolkits` supports `?search=<q>` & `?limit=<n>`; returns `{ items:[{ slug, name, meta:{ tools_count, description, categories:[{id,name}] } }], … }`. We query live per invocation (never cache 1000 rows).
- **Empty `allowed_tools:[]` = ALL tools** (proven). So connecting an uncurated toolkit needs NO per-tool fetch — `listToolkitTools()` is intentionally *not* built (YAGNI).
- **Out of scope (documented, not changed):** the workflow **integration node** validation (`lib/workflows.ts:257`) stays restricted to curated `COMPOSIO_CATALOG` slugs — `validateGraph` is synchronous and can't do a live catalog fetch; relaxing it is a separate future change. The `composio-view.ts` static overlay (Integrations tab API) is slice 4's concern. `mc mcp list` already reads real connection rows, so the CLI surface is fully consistent after this slice.

---

## File Structure

- `lib/composio-api.ts` — **modify**: add `ToolkitSummary` type + `listToolkits(opts?)` wrapper (live `/toolkits` fetch + parse). The existing client owns all Composio HTTP, so this belongs here.
- `lib/composio-catalog.ts` — **modify**: add `allowedToolsFor(slug)` pure helper (`getCatalogEntry(slug)?.allowedTools ?? []`) — the testable seam for "curated → narrow list, else [] = all".
- `lib/composio-connections.ts` — **modify**: `ensureToolkit` uses `allowedToolsFor(slug)` and drops the unknown-toolkit hard-fail, so any slug connects.
- `cli/index.ts` — **modify**: back `mc mcp catalog` with `listToolkits` + `--search`/`--limit`; overlay a `featured` flag; update the command description + the matching `SPEC` entry (the spec-sync test enforces parity).
- `test/composio-api.test.ts` — **modify**: `listToolkits` parse + query-string cases (fetch-mocked).
- `test/composio-catalog.test.ts` — **modify**: `allowedToolsFor` (curated → list, uncurated → []).
- `AGENTS.md`, `cli/README.md` — **modify**: document live catalog + "connect any toolkit".

---

### Task 1: `listToolkits()` live-catalog wrapper

**Files:**
- Modify: `lib/composio-api.ts` (append after `executeAction`, ~line 135)
- Test: `test/composio-api.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/composio-api.test.ts` — import `listToolkits` in the top import block, then add inside the `describe('Composio API wrappers (mocked fetch)', …)` block (it already runs `beforeEach(() => vi.stubEnv('COMPOSIO_API_KEY', 'ak_test'))`):

```ts
it('listToolkits parses items into summaries', async () => {
  mockFetch(200, {
    items: [
      { slug: 'github', name: 'GitHub', meta: { tools_count: 823, description: 'Git host', categories: [{ id: 'dev', name: 'Developer Tools' }] } },
      { slug: 'gmail', name: 'Gmail', meta: { tools_count: 61, description: 'Email', categories: [{ id: 'email', name: 'email' }] } },
    ],
    total_items: 1043,
  });
  const out = await listToolkits();
  expect(out).toEqual([
    { slug: 'github', name: 'GitHub', description: 'Git host', toolCount: 823, categories: ['Developer Tools'] },
    { slug: 'gmail', name: 'Gmail', description: 'Email', toolCount: 61, categories: ['email'] },
  ]);
});

it('listToolkits tolerates missing meta fields', async () => {
  mockFetch(200, { items: [{ slug: 'bare', name: 'Bare' }] });
  expect(await listToolkits()).toEqual([{ slug: 'bare', name: 'Bare', description: '', toolCount: 0, categories: [] }]);
});

it('listToolkits passes search + limit as query params', async () => {
  mockFetch(200, { items: [] });
  await listToolkits({ search: 'git', limit: 25 });
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/toolkits?'), expect.anything());
  const url = (fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
  expect(url).toContain('search=git');
  expect(url).toContain('limit=25');
});

it('listToolkits defaults limit to 50 when omitted', async () => {
  mockFetch(200, { items: [] });
  await listToolkits();
  const url = (fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
  expect(url).toContain('limit=50');
  expect(url).not.toContain('search=');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/composio-api.test.ts`
Expected: FAIL — `listToolkits is not a function` / import error.

- [ ] **Step 3: Implement `listToolkits`**

Append to `lib/composio-api.ts`:

```ts
/** A toolkit as shown in the catalog browser (a thin projection of GET /toolkits). */
export type ToolkitSummary = {
  slug: string;
  name: string;
  description: string;
  toolCount: number;
  categories: string[];
};

type RawToolkit = {
  slug?: string;
  name?: string;
  meta?: { tools_count?: number; description?: string; categories?: { id?: string; name?: string }[] };
};

/** List Composio's live toolkit catalog (no DB). `search` is a server-side fuzzy filter; `limit`
 *  caps the page (default 50, Composio max 500). Returns one page — a browse command, not an export. */
export async function listToolkits(opts?: { search?: string; limit?: number }): Promise<ToolkitSummary[]> {
  const params = new URLSearchParams();
  if (opts?.search) params.set('search', opts.search);
  params.set('limit', String(opts?.limit ?? 50));
  const j = (await composioFetch(`/toolkits?${params.toString()}`)) as { items?: RawToolkit[] };
  return (j.items ?? []).map((t) => ({
    slug: t.slug ?? '',
    name: t.name ?? t.slug ?? '',
    description: t.meta?.description ?? '',
    toolCount: t.meta?.tools_count ?? 0,
    categories: (t.meta?.categories ?? []).map((c) => c.name ?? c.id ?? '').filter(Boolean),
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/composio-api.test.ts`
Expected: PASS (all cases, including the existing wrappers).

- [ ] **Step 5: Commit**

```bash
git add lib/composio-api.ts test/composio-api.test.ts
git commit -m "feat: listToolkits() live Composio catalog wrapper (slice 2)"
```

---

### Task 2: `allowedToolsFor` helper + relax `ensureToolkit` to any toolkit

**Files:**
- Modify: `lib/composio-catalog.ts`
- Modify: `lib/composio-connections.ts:15-28` (`ensureToolkit`)
- Test: `test/composio-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/composio-catalog.test.ts` (import `allowedToolsFor` from `../lib/composio-catalog`):

```ts
describe('allowedToolsFor', () => {
  it('returns the curated tool list for a known toolkit', () => {
    expect(allowedToolsFor('linear')).toContain('LINEAR_CREATE_LINEAR_ISSUE');
    expect(allowedToolsFor('linear').length).toBeGreaterThan(0);
  });
  it('returns [] for an uncurated toolkit (Composio expands [] to all tools)', () => {
    expect(allowedToolsFor('github')).toEqual([]);
    expect(allowedToolsFor('totally-unknown')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/composio-catalog.test.ts`
Expected: FAIL — `allowedToolsFor is not a function`.

- [ ] **Step 3: Implement the helper**

Append to `lib/composio-catalog.ts`:

```ts
/** The allow-list to bind a toolkit's MCP server to: the curated list for a known toolkit, else `[]`.
 *  Composio expands `[]` to ALL of the toolkit's tools (verified live) — so any toolkit is connectable,
 *  with curated toolkits kept deliberately narrow. */
export function allowedToolsFor(slug: string): string[] {
  return getCatalogEntry(slug)?.allowedTools ?? [];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/composio-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Relax `ensureToolkit`**

In `lib/composio-connections.ts`, change the import on line 4 from:

```ts
import { getCatalogEntry } from './composio-catalog';
```
to:
```ts
import { allowedToolsFor } from './composio-catalog';
```

Then replace the body of `ensureToolkit` (lines 15-28) so it no longer hard-fails on an unknown slug and uses `allowedToolsFor`:

```ts
export async function ensureToolkit(slug: string): Promise<{ authConfigId: string; mcpServerId: string; mcpUrl: string }> {
  let row = await getToolkitRow(slug);
  if (!row?.authConfigId) {
    const authConfigId = await createAuthConfig(slug); // Composio rejects an unknown/no-auth slug with a 400 → ComposioApiError
    row = await upsertToolkitRow(slug, { authConfigId });
  }
  if (!row.mcpServerId || !row.mcpUrl) {
    const { mcpServerId, mcpUrl } = await createMcpServer(slug, row.authConfigId!, allowedToolsFor(slug));
    row = await upsertToolkitRow(slug, { mcpServerId, mcpUrl });
  }
  return { authConfigId: row.authConfigId!, mcpServerId: row.mcpServerId!, mcpUrl: row.mcpUrl! };
}
```

(Note: `getCatalogEntry` is no longer used by this file. The `ValidationError` import may now be unused — remove it from the import on line 11 **only if** no other reference remains in the file; `grep -n "ValidationError" lib/composio-connections.ts` first. `NotFoundError` is still used.)

- [ ] **Step 6: Verify no dangling references + full suite for this file's deps**

Run: `grep -n "getCatalogEntry\|ValidationError" lib/composio-connections.ts` (expect: no `getCatalogEntry`; confirm `ValidationError` either still used or removed from imports)
Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep "composio-connections" || echo "no new tsc errors in file"`
Run: `npx vitest run test/composio-catalog.test.ts test/composio-mcp-resolve.test.ts`
Expected: clean; tests PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/composio-catalog.ts lib/composio-connections.ts test/composio-catalog.test.ts
git commit -m "feat: connect any toolkit — allowedToolsFor + ensureToolkit relax (slice 2)"
```

---

### Task 3: Back `mc mcp catalog` with the live catalog (`--search`/`--limit` + `featured`)

**Files:**
- Modify: `cli/index.ts:888-903` (the `mcp catalog` command) and the `SPEC` entry at ~line 355
- Guard: `test/spec-sync.test.ts` must stay GREEN (it enforces command-*name* parity between SPEC and the program; it does **not** compare per-command options for `mcp catalog`, so the SPEC `options` field below is documentation hygiene, not test-enforced). Verification of behavior is the live smoke in Step 4.

`withFlags` only adds `--json`/`--human` (confirmed: `cli/index.ts:406-408`), so defining `--search`/`--limit` here does not collide — same pattern as `project list` defining its own `--limit`.

- [ ] **Step 1: Update the `SPEC` entry (hygiene — keeps the catalog consistent with other option-bearing commands)**

In `cli/index.ts`, replace the `mcp catalog` SPEC line (~355):

```ts
  { name: 'mcp catalog', readonly: true, summary: 'List supported Composio toolkits' },
```
with:
```ts
  { name: 'mcp catalog', readonly: true, summary: "List Composio's full live catalog", options: ['--search', '--limit'] },
```

- [ ] **Step 2: Rewrite the `mcp catalog` command**

Replace lines 888-903 (the `withFlags(mcp.command('catalog'))…` block):

```ts
withFlags(mcp.command('catalog'))
  .description("List Composio's full live catalog")
  .option('--search <q>', 'Filter the catalog (server-side fuzzy match)')
  .option('--limit <n>', 'Max toolkits to return (default 50, max 500)')
  .action((opts: LeafOpts) =>
    emit('mcp catalog', opts, async () => {
      const { listToolkits } = await import('../lib/composio-api');
      const { COMPOSIO_CATALOG } = await import('../lib/composio-catalog');
      const toolkits = await listToolkits({
        search: opts.search as string | undefined,
        limit: opts.limit ? Number(opts.limit) : undefined,
      });
      const items = toolkits.map((t) => ({ ...t, featured: t.slug in COMPOSIO_CATALOG }));
      return {
        data: { items, count: items.length },
        human: () =>
          items.forEach((t) => console.log(`${t.featured ? '★' : ' '} ${t.slug}  ${t.name}  (${t.toolCount} tools)`)),
      };
    }),
  );
```

(`--search`/`--limit` are read off `opts` exactly like `project list` reads `opts.limit`. The command needs `COMPOSIO_API_KEY` in the host env but no DB — so it does **not** call `ensureDbCredentials()`, matching the prior behavior. `LeafOpts` already permits arbitrary string option fields; if tsc complains about `opts.search`/`opts.limit`, cast as shown.)

- [ ] **Step 3: Run spec-sync (stays green) + a live CLI smoke**

Run: `npx vitest run test/spec-sync.test.ts`
Expected: PASS (command-name parity unchanged).
Run: `node --env-file=.env.local cli/index.ts mcp catalog --search git --limit 5 --json | head -c 400`
Expected: a `{"ok":true,"command":"mcp catalog","data":{"items":[…github…],"count":…}}` envelope with `featured:true` on linear. (Live Composio call — proves the wiring end-to-end; this is the real verification for this task.)

- [ ] **Step 4: Commit**

```bash
git add cli/index.ts
git commit -m "feat: mc mcp catalog lists the live Composio catalog with --search/--limit (slice 2)"
```

---

### Task 4: Docs + memory sweep

**Files:**
- Modify: `AGENTS.md` (the `mc mcp catalog` and `mc mcp connect` lines)
- Modify: `cli/README.md` (mcp section, if it enumerates catalog/connect)

- [ ] **Step 1: Update `AGENTS.md`**

Find the `mc mcp catalog` line and update it to describe the live catalog:

```
mc mcp catalog [--search <q>] [--limit <n>]   # list Composio's FULL live catalog (1043 toolkits) via GET /api/v3/toolkits; --search is a server-side fuzzy filter, --limit caps the page (default 50, max 500); items carry {slug,name,description,toolCount,categories,featured} where featured = in the curated editorial set. No DB; reads COMPOSIO_API_KEY from host env (never stored)
```

Find the `mc mcp connect <slug> <toolkit>` line and append a clause noting any toolkit is connectable:

```
… connect ANY catalog toolkit (not just the curated pair): a curated toolkit (linear|slack) binds its narrow tool list; any other toolkit binds allowed_tools=[] which Composio expands to ALL of that toolkit's tools. At most one connection per (project, toolkit).
```

- [ ] **Step 2: Update `cli/README.md`** (only if it lists the mcp commands — `grep -n "mcp catalog" cli/README.md`; mirror the AGENTS.md phrasing if present, else skip.)

- [ ] **Step 3: Run the full gate suite**

Run: `npx vitest run`
Expected: all green (tests hit the real Neon dev/prod branch per repo convention).
Run: `npx eslint lib/composio-api.ts lib/composio-catalog.ts lib/composio-connections.ts cli/index.ts test/composio-api.test.ts test/composio-catalog.test.ts`
Expected: exit 0 (use `npx eslint <files>`, NOT `npm run lint` which is a broken no-op).
Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | tail -5`
Expected: no NEW errors beyond the 4 pre-existing `WorkflowNode` errors in `test/workflow-runner.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md cli/README.md
git commit -m "docs: document mc mcp catalog live catalog + connect-any-toolkit (slice 2)"
```

- [ ] **Step 5: Update memory** (`project_mcp_unification.md`): mark slice 2 SHIPPED with the PR/commit; note the deferred items (workflow node stays curated; composio-view overlay is slice 4).

---

## Testing Summary

- `listToolkits` parse + query-param cases — fetch-mocked, CI-safe (`test/composio-api.test.ts`).
- `allowedToolsFor` curated-vs-empty (`test/composio-catalog.test.ts`).
- spec-sync parity for the new `mcp catalog` options (`test/spec-sync.test.ts`).
- Live smoke: `mc mcp catalog --search git` against real Composio (Task 3 Step 4) — proves the wiring; not a unit test.
- No live-Composio unit test for `ensureToolkit` connecting an uncurated toolkit (it hits real Composio OAuth); the `allowedToolsFor` helper test covers the logic seam, and the live smoke covers catalog wiring.

## Out of Scope (documented, deferred)

- Workflow **integration node** validation stays restricted to curated `COMPOSIO_CATALOG` slugs (sync `validateGraph` can't fetch). A future change could relax it.
- `composio-view.ts` static overlay (Integrations tab API) — slice 4 (MCP tab UI) rebuilds it against live/connected data.
- `mc mcp connect --tools T1,T2` (per-connect tool narrowing) — unneeded for MVP (empty=all works); also semantically muddy under the shared one-server-per-toolkit cache. Revisit only if a real need appears.

---

## Review (post-implementation)

Shipped as PR #35 (5 commits: `a1dacbc` listToolkits → `8a5a4cc` allowedToolsFor/ensureToolkit relax → `25f318d` live `mc mcp catalog` → `dd20500` docs → `ae32e7c` review fixes). Executed via subagent-driven development (one implementer per task, verified each diff).

**Plan deviations (all improvements, none regressions):**
- `listToolkitTools()` was dropped entirely — the live spike proved empty `allowed_tools: []` = all tools, so connecting an uncurated toolkit needs no per-tool fetch (YAGNI). This collapsed Task 2 to a one-line `allowedToolsFor` helper.
- Task 3's "failing spec-sync test" framing was corrected mid-plan: spec-sync enforces command-*name* parity only, not per-command options, so the SPEC `options` update is hygiene and the live smoke is the real verification.

**Final code review (1 agent over the whole diff) — 3 findings:**
- [IMPORTANT] stale `mc composio connect` re-auth hints (slice-1 rename miss) in `composio-api.ts` + `daemon/workflow-runner.ts`, masked by a test asserting the same stale string → **fixed** (`ae32e7c`), completing the rename repo-wide (grep confirms zero `mc composio` remain).
- [MINOR] `--limit` forwarded `NaN` to Composio → **fixed** with the existing `num()` helper.
- [IMPORTANT] workflow integration node validator still rejects non-curated toolkits with a `supported: linear, slack` message → **deferred by design** (sync `validateGraph` can't do a live fetch; out of this slice's scope; doesn't regress prior behavior). Tracked as future "relax workflow validation" work.

**Gates:** 547 tests green (was 541); targeted re-run after review fixes 150 green; eslint clean; tsc no new errors; live smoke verified against real Composio.

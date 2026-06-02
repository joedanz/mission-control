# Composio Linear Agent-Can-Act Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove a `claude` agent spawned through Mission Control's existing executor can invoke a real Composio **Linear** tool and create (then read back) a Linear issue — leaving behind a CI-safe contract test, a re-runnable manual smoke harness, and a setup runbook.

**Architecture:** No new production code. MC already validates `http` MCP servers (`lib/profiles.ts`) and resolves `${ENV}` header placeholders into the `--mcp-config` temp file at spawn (`daemon/render-profile.ts` → `daemon/runner.ts`). The Composio hosted-MCP endpoint drops straight into a profile's `mcpServers`. This slice adds: (1) a pure test pinning the Composio shape, (2) a `scripts/` harness that loads the `composio-linear` profile by slug and spawns it through the real `spawnExecutor`/`monitorAndFinalize` path, (3) a runbook.

**Tech Stack:** TypeScript, tsx (`--env-file=.env.local`), Vitest (node, real Neon for DB tests — but this slice's test is pure/no-DB), Composio hosted MCP, the `claude` CLI.

**Spec:** `docs/superpowers/specs/2026-06-02-composio-linear-agent-loop-design.md`

---

## File Structure

- **Create** `test/composio-mcp-shape.test.ts` — pure, CI-safe. Pins that `validateProfile` accepts the Composio Linear `http` shape and that `resolveMcpConfigJson` injects `${COMPOSIO_API_KEY}` into the `x-api-key` header (and throws `MissingEnvError` when unset). One responsibility: guard the transport linchpin forever.
- **Create** `scripts/smoke-composio-linear.ts` — manual, env-guarded harness. Loads the persisted `composio-linear` profile, spawns it via the real executor with a create-then-read-back prompt, asserts the issue was created. SKIPs cleanly (exit 0) without creds/profile.
- **Modify** `package.json` — add `"smoke:composio"` script.
- **Create** `docs/runbooks/composio-linear-smoke.md` — plain-markdown setup runbook (Composio account → Linear connect → MCP server → `mc profile add` → run the harness → interpret results).

Already done on this branch (commit `b3afda3`): the design spec and the `.env.example` Composio block.

---

### Task 1: CI-safe Composio MCP-shape contract test

This test characterizes existing behavior to **pin the Composio contract** — it passes immediately because the plumbing already exists. The "guard has teeth" case (a malformed shape must throw) proves the test is meaningful rather than vacuous.

**Files:**
- Create: `test/composio-mcp-shape.test.ts`

- [ ] **Step 1: Write the test**

```ts
// ABOUTME: Pins the Composio Linear MCP contract — that MC's profile validator accepts the hosted-MCP
// ABOUTME: shape (http + url + x-api-key header) and the daemon resolves ${COMPOSIO_API_KEY} into the header.
// ABOUTME: CI-safe + pure (no network, no DB): guards the linchpin the whole Integrations reshape depends on.

import { describe, it, expect } from 'vitest';
import type { McpServerConfig } from '../lib/db/schema';
import { validateProfile, type EffectiveProfile } from '../lib/profiles';
import { resolveMcpConfigJson, MissingEnvError } from '../daemon/render-profile';

const COMPOSIO_LINEAR: Record<string, McpServerConfig> = {
  'composio-linear': {
    type: 'http',
    url: 'https://backend.composio.dev/v3/mcp/srv_test123?user_id=user_smoke',
    headers: { 'x-api-key': '${COMPOSIO_API_KEY}' },
  },
};

function profileWith(mcpServers: Record<string, McpServerConfig> | null): EffectiveProfile {
  return { runtime: 'claude-code', mcpServers };
}

describe('Composio Linear MCP contract', () => {
  it('validateProfile accepts the hosted-MCP http shape', () => {
    expect(() => validateProfile(profileWith(COMPOSIO_LINEAR))).not.toThrow();
  });

  it('validateProfile rejects an http server with no url (guard has teeth)', () => {
    const bad: Record<string, McpServerConfig> = {
      'composio-linear': { type: 'http', headers: { 'x-api-key': '${COMPOSIO_API_KEY}' } },
    };
    expect(() => validateProfile(profileWith(bad))).toThrow(/requires a url/);
  });

  it('resolveMcpConfigJson injects COMPOSIO_API_KEY into the x-api-key header', () => {
    const json = resolveMcpConfigJson(COMPOSIO_LINEAR, { COMPOSIO_API_KEY: 'sk_live_abc' });
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json as string) as { mcpServers: Record<string, McpServerConfig> };
    expect(parsed.mcpServers['composio-linear'].headers!['x-api-key']).toBe('sk_live_abc');
    // url passes through untouched — placeholders only resolve in env/headers, never the url.
    expect(parsed.mcpServers['composio-linear'].url).toContain('user_id=user_smoke');
  });

  it('resolveMcpConfigJson throws MissingEnvError when COMPOSIO_API_KEY is unset', () => {
    try {
      resolveMcpConfigJson(COMPOSIO_LINEAR, {});
      throw new Error('expected MissingEnvError');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingEnvError);
      expect((e as MissingEnvError).varName).toBe('COMPOSIO_API_KEY');
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/composio-mcp-shape.test.ts`
Expected: PASS, 4/4. (Passes immediately — the plumbing exists; this test now guards it.)

- [ ] **Step 3: Lint**

Run: `npx eslint test/composio-mcp-shape.test.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add test/composio-mcp-shape.test.ts
git commit -m "test: pin Composio Linear MCP contract (validate + header resolution)"
```

---

### Task 2: Manual smoke harness (real executor)

The harness proves the loop end-to-end. It cannot run in CI (needs real Composio + a live `claude` spawn), so its automated, always-available check is the **SKIP path**: with no creds / no profile it must print `SKIP` and exit 0. The PASS path is exercised manually once the operator completes the runbook.

**Files:**
- Create: `scripts/smoke-composio-linear.ts`
- Modify: `package.json` (add the `smoke:composio` script)

- [ ] **Step 1: Write the harness**

```ts
// ABOUTME: Manual smoke harness proving the Composio agent-can-act loop — spawns a real `claude` via MC's
// ABOUTME: executor with the `composio-linear` profile and asserts it created + read back a Linear issue.
// ABOUTME: Run: `npm run smoke:composio` (loads .env.local; SKIPs cleanly without creds/profile).

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getProfileBySlug } from '../lib/queries';
import { spawnExecutor, monitorAndFinalize, mc, type Log, type Spawned } from '../daemon/runner';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_SLUG = 'composio-linear';
const RUNBOOK = 'docs/runbooks/composio-linear-smoke.md';
const log: Log = (m) => console.log(`[smoke] ${m}`);

function skip(reason: string): never {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}
function fail(reason: string): never {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

type SmokeResult = { issueId?: string; identifier?: string; url?: string; title?: string };

/** Pull the agent's final text from `claude -p --output-format json` stdout, then the MC_SMOKE_RESULT JSON. */
function parseSmokeResult(stdout: string): SmokeResult | null {
  let text = '';
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t) as { result?: unknown };
      if (typeof o.result === 'string') text = o.result;
    } catch {
      /* not a JSON line — skip */
    }
  }
  const m = text.match(/MC_SMOKE_RESULT:\s*(\{.*\})/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as SmokeResult;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (!process.env.COMPOSIO_API_KEY) {
    skip(`COMPOSIO_API_KEY not set — add it to .env.local (see ${RUNBOOK})`);
  }
  const profile = await getProfileBySlug(PROFILE_SLUG);
  if (!profile) {
    skip(`profile "${PROFILE_SLUG}" not found — create it per ${RUNBOOK}`);
  }
  if (!profile.mcpServers || Object.keys(profile.mcpServers).length === 0) {
    skip(`profile "${PROFILE_SLUG}" has no mcpServers — see ${RUNBOOK}`);
  }

  const runId = randomUUID();
  const marker = `MC-SMOKE-${runId.slice(0, 8)}`;
  const prompt = [
    'You are a smoke test for Mission Control. Using ONLY your Linear MCP tools:',
    '1. List your Linear teams and pick the first one.',
    `2. Create an issue in that team titled EXACTLY "${marker}" with body "Mission Control Composio smoke test".`,
    '3. Fetch that issue back by its id to confirm it persisted.',
    'Then output, as the LAST line of your reply, EXACTLY one line of JSON prefixed with "MC_SMOKE_RESULT: ":',
    `MC_SMOKE_RESULT: {"issueId":"<id>","identifier":"<TEAM-123>","url":"<url>","title":"${marker}"}`,
    'Output nothing after that line.',
  ].join('\n');

  // Open a real run so MC_RUN_ID + hooks bind exactly as in production.
  const started = await mc([
    'run', 'start', '--id', runId, '--agent', 'mc-smoke-composio',
    '--source', 'manual', '--profile', PROFILE_SLUG, '--work-dir', ROOT,
  ]);
  if (!started.ok) {
    fail(`mc run start failed: ${started.error?.code ?? started.code} ${started.error?.message ?? ''}`);
  }

  log(`spawning ${PROFILE_SLUG} (run ${runId.slice(0, 8)}, marker ${marker})`);
  let spawned: Spawned;
  try {
    spawned = spawnExecutor({
      prompt,
      runId,
      repoPath: ROOT,
      profile,
      effectiveModel: profile.model ?? null,
      basePermissionMode: 'bypassPermissions',
    });
  } catch (e) {
    await mc(['run', 'end', runId, 'failed']);
    fail(`spawn failed (likely MissingEnvError for a profile secret): ${(e as Error).message}`);
  }

  const { status } = await monitorAndFinalize(spawned, runId, { timeoutSec: 240, graceSec: 10 }, log);
  log(`run ${runId.slice(0, 8)} terminal status: ${status}`);

  const result = parseSmokeResult(spawned.output());
  if (!result) {
    fail(`agent did not emit MC_SMOKE_RESULT (status=${status}). The MCP server may not have loaded or the tool call failed — see the run output above.`);
  }
  if (result.title !== marker) {
    fail(`issue title "${result.title}" != expected marker "${marker}" — wrong or hallucinated issue`);
  }
  if (!result.issueId || !result.url) {
    fail(`MC_SMOKE_RESULT missing issueId/url: ${JSON.stringify(result)}`);
  }

  console.log(`PASS: agent created + read back Linear issue ${result.identifier ?? result.issueId}`);
  console.log(`  url: ${result.url}`);
  console.log('  Out-of-band confirm: open the URL above (or the Composio dashboard) to eyeball the issue.');
  process.exit(0);
}

main().catch((e) => fail((e as Error).stack ?? String(e)));
```

- [ ] **Step 2: Add the npm script**

In `package.json` `"scripts"`, add this entry next to the existing `"reap"` line (which uses the same `tsx --env-file=.env.local` pattern):

```json
"smoke:composio": "tsx --env-file=.env.local scripts/smoke-composio-linear.ts",
```

- [ ] **Step 3: Verify the SKIP path (no creds needed)**

Run: `COMPOSIO_API_KEY= npx tsx scripts/smoke-composio-linear.ts`
Expected: prints `SKIP: COMPOSIO_API_KEY not set …` and exits 0.

Then confirm it runs via the npm script too (this loads `.env.local`; if your `.env.local` now has a real `COMPOSIO_API_KEY` but no `composio-linear` profile yet, expect the second SKIP):

Run: `npm run smoke:composio`
Expected: a `SKIP:` line (either "COMPOSIO_API_KEY not set" or `profile "composio-linear" not found`) and exit 0 — never a stack trace.

- [ ] **Step 4: Lint + typecheck**

Run: `npx eslint scripts/smoke-composio-linear.ts`
Expected: no errors.
Run: `npx tsc --noEmit`
Expected: no errors (the harness compiles against the real executor/query signatures).

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-composio-linear.ts package.json
git commit -m "feat: manual smoke harness for the Composio Linear agent loop"
```

---

### Task 3: Setup runbook

**Files:**
- Create: `docs/runbooks/composio-linear-smoke.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Runbook: Composio → Linear agent-can-act smoke test

Proves that a `claude` agent spawned by Mission Control's executor can act on a long-tail service
(Linear) through a Composio-hosted MCP server. One-time external setup, then a re-runnable harness.

## Prerequisites
- A Composio account: <https://app.composio.dev>
- A Linear account you can connect.
- `mc` CLI linked (`npm link` from this repo).

## 1. Get your Composio API key
1. Sign in at <https://app.composio.dev>.
2. Settings → copy your **API key**.
3. Add it to `.env.local` (gitignored) at the repo root:
   ```
   COMPOSIO_API_KEY=<your key>
   ```

## 2. Create a Linear auth config + connect your Linear account
In the Composio dashboard:
1. Toolkits → **Linear** → create an **auth config** (OAuth is fine; Composio supplies a managed dev
   OAuth app, so you don't need your own Linear OAuth credentials for the proof).
2. Connect a Linear account under a **user id** of your choice (e.g. `user_smoke`). Complete the OAuth
   consent. Confirm the connected account shows status **ACTIVE**.

## 3. Create a Composio MCP server for Linear
1. In the dashboard, create an **MCP server** bound to the Linear toolkit + the auth config above.
2. Allow-list at least: `LINEAR_LIST_TEAMS`, `LINEAR_CREATE_ISSUE`, and a read tool
   (`LINEAR_GET_ISSUE` / `LINEAR_LIST_ISSUES`).
3. Generate the **per-user MCP URL** for your user id. It looks like:
   ```
   https://backend.composio.dev/v3/mcp/<SERVER_ID>?user_id=user_smoke
   ```
4. (Optional, for your own records) store it in `.env.local`:
   ```
   COMPOSIO_LINEAR_MCP_URL=https://backend.composio.dev/v3/mcp/<SERVER_ID>?user_id=user_smoke
   ```

## 4. Create the `composio-linear` agent profile
The profile bakes the literal MCP URL into `mcpServers.url` and references the key as the placeholder
`${COMPOSIO_API_KEY}` in the header — the daemon resolves it from your env at spawn (never stored in
the DB). `bypassPermissions` lets the headless agent call the MCP tools without a prompt.

```bash
mc profile add \
  --slug composio-linear \
  --name "Composio Linear (smoke)" \
  --permission-mode bypassPermissions \
  --mcp-config '{"composio-linear":{"type":"http","url":"https://backend.composio.dev/v3/mcp/<SERVER_ID>?user_id=user_smoke","headers":{"x-api-key":"${COMPOSIO_API_KEY}"}}}'
```

Verify it stored the placeholder (NOT a resolved secret):
```bash
mc profile get composio-linear --json
```

## 5. Run the smoke test
```bash
npm run smoke:composio
```

### Interpreting the result
- `SKIP: …` — a prerequisite is missing (no `COMPOSIO_API_KEY`, or the profile/mcpServers absent). Fix
  and re-run. Exit code 0.
- `PASS: …` — the agent created a Linear issue and read it back; the harness prints the issue URL.
- `FAIL: …` — read the reason:
  - *"spawn failed (likely MissingEnvError…)"* — `COMPOSIO_API_KEY` isn't in the harness env.
  - *"agent did not emit MC_SMOKE_RESULT"* — the MCP server didn't load or the tool call failed; scroll
    up to the teed `claude` output. Common causes: the connected account isn't ACTIVE, the allow-list
    omits the needed tool, or the CLI rejected the remote MCP shape (the one assumption this proves —
    if so, that is the finding; capture the error).
  - *"wrong or hallucinated issue"* — the returned title didn't match the unique marker.

### Out-of-band confirmation
On PASS, open the printed issue URL (or the Composio dashboard / Linear) to eyeball the issue exists.

## Teardown
Delete the smoke issues in Linear when done. To remove the profile: `mc profile rm composio-linear --yes`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/composio-linear-smoke.md
git commit -m "docs: runbook for the Composio Linear smoke test"
```

---

### Task 4: Final gates

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all pass, including `test/composio-mcp-shape.test.ts`. (Tests hit the real Neon DB per repo convention; the new file is pure and adds no DB rows.)

- [ ] **Step 2: Lint the whole change**

Run: `npx eslint test/composio-mcp-shape.test.ts scripts/smoke-composio-linear.ts`
Expected: no errors.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: SKIP-path sanity**

Run: `npm run smoke:composio`
Expected: a clean `SKIP:` (or `PASS:` if the operator has fully set up Composio) — never an unhandled stack trace.

---

## Self-Review

**Spec coverage:**
- "Prove the loop via the real executor" → Task 2 (uses `spawnExecutor`/`monitorAndFinalize`, the daemon's own path). ✓
- "CI-safe unit tests for config-shape + `${ENV}` header resolution" → Task 1. ✓
- "Harness loads the persisted profile by slug" → Task 2 (`getProfileBySlug('composio-linear')`, SKIP if absent). ✓
- "env-guarded, SKIP without creds, exit 0" → Task 2 Step 3. ✓
- "Independently confirm the issue (no hallucinated done)" → Task 2 asserts a marker-matched create **and** an agent read-back, plus the runbook's out-of-band URL eyeball. ✓
- "Runbook (plain markdown)" → Task 3 at `docs/runbooks/`. ✓
- "No new production code" → only a test, a script, a doc, and one `package.json` script line. ✓
- ".env.example block" → already on the branch (`b3afda3`). ✓

**Placeholder scan:** No TBD/TODO. `<SERVER_ID>`/`<id>`/`<TEAM-123>` are intentional user-supplied values in runbook/prompt templates, not plan gaps.

**Type consistency:** `spawnExecutor(SpawnExecutorOpts)` fields (`prompt/runId/repoPath/profile/effectiveModel/basePermissionMode`) match `daemon/runner.ts`. `monitorAndFinalize(spawned, runId, {timeoutSec,graceSec}, log)` matches. `getProfileBySlug → AgentProfile | null` matches. `resolveMcpConfigJson(servers, hostEnv)` + `MissingEnvError.varName` match `daemon/render-profile.ts`. `validateProfile(EffectiveProfile)` + `EffectiveProfile.{runtime,mcpServers}` match `lib/profiles.ts`. `Spawned`/`Log` are exported from `daemon/runner.ts`. ✓

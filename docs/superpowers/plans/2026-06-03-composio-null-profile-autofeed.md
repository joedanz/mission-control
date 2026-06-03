# Null-Profile Composio Auto-Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A profileless auto-claim spawn (`planSpawn` with `profile === null`) inherits the project's ACTIVE Composio connections as `mcpServers`, rendered with `--mcp-config --strict-mcp-config` like the profile path.

**Architecture:** Remove three aligned `if (profile)` / `profile ?` guards so the existing slice-4 auto-feed machinery also runs when no profile resolves. No new files, no schema, no migration. Back-compat is preserved because `mergeMcpServers(undefined, undefined)` returns `null` → no `--mcp-config` → unchanged spawn whenever a project has zero active connections.

**Tech Stack:** TypeScript, Vitest (pure unit tests — no DB), Node child_process daemons.

**Approved spec:** `docs/superpowers/specs/2026-06-03-composio-null-profile-autofeed-design.md`

---

## File Structure

- `daemon/render-profile.ts` — pure profile→spawn renderer. **Change:** `planSpawn`'s null branch appends `--mcp-config <path> --strict-mcp-config` when `mcpConfigPath` is set. This is the only behavior-bearing edit, and it is the one the tests pin.
- `daemon/runner.ts` — shared spawn seam. **Change:** drop the `profile ?` guard so `extraMcpServers` resolves even with no profile; update the `SpawnExecutorOpts.extraMcpServers` doc comment.
- `daemon/auto-claim.ts` — per-project task puller. **Change:** drop the `profile ?` guard on the `fetchComposioMcpServers` call (+ its comment) so a profileless spawn also fetches.
- `test/daemon-render.test.ts` — pure planSpawn tests. **Change:** add the strict-args assertion and tighten the existing back-compat test.

Order matters: do the renderer (Task 1) first because its tests are the gate; then the seam (Task 2); then the caller (Task 3). Each task ends green and committed.

---

### Task 1: planSpawn null branch renders `--mcp-config --strict-mcp-config`

**Files:**
- Modify: `daemon/render-profile.ts:143-150` (the `if (!profile)` branch)
- Test: `test/daemon-render.test.ts:110-120` (the existing `planSpawn — no profile (back-compat)` describe)

- [ ] **Step 1: Add the failing test + reinforce the back-compat test**

In `test/daemon-render.test.ts`, replace the existing `describe('planSpawn — no profile (back-compat)', …)` block (lines 110-120) with this expanded version. The first `it` is unchanged (the no-`mcpConfigPath` case must STAY byte-for-byte historical); the second `it` is new and currently fails because the null branch ignores `mcpConfigPath`:

```ts
describe('planSpawn — no profile (back-compat)', () => {
  it('renders the daemon historical claude -p plan spawn (no auto-fed servers)', () => {
    const plan = planSpawn(null, { prompt: PROMPT, basePermissionMode: 'plan', hostEnv: {} });
    expect(plan).toEqual({
      runtime: 'claude-code',
      bin: 'claude',
      args: ['-p', PROMPT, '--permission-mode', 'plan', '--output-format', 'json'],
      extraEnv: {},
    });
  });

  it('appends --mcp-config + --strict-mcp-config when servers are auto-fed (mcpConfigPath set)', () => {
    const plan = planSpawn(null, { prompt: PROMPT, basePermissionMode: 'plan', mcpConfigPath: '/tmp/mc-mcp-x.json', hostEnv: {} });
    expect(plan.args).toEqual([
      '-p', PROMPT, '--permission-mode', 'plan', '--output-format', 'json',
      '--mcp-config', '/tmp/mc-mcp-x.json', '--strict-mcp-config',
    ]);
    expect(plan.runtime).toBe('claude-code');
  });
});
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `npx vitest run test/daemon-render.test.ts -t "no profile"`
Expected: the back-compat test PASSES; the new `--mcp-config` test FAILS (argv has no `--mcp-config` — the null branch drops `mcpConfigPath`).

- [ ] **Step 3: Implement — make the null branch honor `mcpConfigPath`**

In `daemon/render-profile.ts`, replace the `if (!profile)` block (currently lines 143-150):

```ts
  if (!profile) {
    return {
      runtime: 'claude-code',
      bin: claudeBin,
      args: ['-p', prompt, '--permission-mode', basePermissionMode, '--output-format', 'json'],
      extraEnv: {},
    };
  }
```

with:

```ts
  if (!profile) {
    // Historical back-compat invocation when nothing is auto-fed. With auto-fed Composio servers
    // (mcpConfigPath set), add --mcp-config + --strict-mcp-config exactly like the profile path —
    // the profileless agent then sees those servers and nothing else (no host MCP bleed-in).
    const args = ['-p', prompt, '--permission-mode', basePermissionMode, '--output-format', 'json'];
    if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
    return { runtime: 'claude-code', bin: claudeBin, args, extraEnv: {} };
  }
```

(`mcpConfigPath` is already destructured from `opts` at the top of `planSpawn` — no new binding needed.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/daemon-render.test.ts -t "no profile"`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add daemon/render-profile.ts test/daemon-render.test.ts
git commit -m "feat: planSpawn null branch renders --mcp-config when servers auto-fed"
```

---

### Task 2: Resolve `extraMcpServers` at the seam even with no profile

**Files:**
- Modify: `daemon/runner.ts:147-149` (the `extraMcpServers` doc comment on `SpawnExecutorOpts`)
- Modify: `daemon/runner.ts:175` (the `mcpJson` seam)

- [ ] **Step 1: Implement — drop the `profile ?` guard on the seam**

In `daemon/runner.ts`, replace line 175:

```ts
  const mcpJson = profile ? resolveMcpConfigJson(mergeMcpServers(profile.mcpServers, opts.extraMcpServers), process.env) : null;
```

with:

```ts
  const mcpJson = resolveMcpConfigJson(mergeMcpServers(profile?.mcpServers, opts.extraMcpServers), process.env);
```

`profile?.mcpServers` is `undefined` when there is no profile; `mergeMcpServers(undefined, undefined)` returns `null`, so a profileless spawn with no connections still produces no `--mcp-config` (back-compat). `resolveMcpConfigJson(null, …)` already returns `null`.

- [ ] **Step 2: Update the doc comment on `extraMcpServers`**

In `daemon/runner.ts`, the `extraMcpServers` field of `SpawnExecutorOpts` (lines 147-149) currently reads:

```ts
  /** Project-derived Composio MCP servers (from `mc composio mcp-config`), merged UNDER the profile's
   *  own mcpServers (the profile wins a key collision). Ignored when there is no profile. */
  extraMcpServers?: Record<string, McpServerConfig>;
```

Replace the comment with (drop the "Ignored when there is no profile" clause):

```ts
  /** Project-derived Composio MCP servers (from `mc composio mcp-config`), merged UNDER the profile's
   *  own mcpServers (the profile wins a key collision). With no profile they are used as-is (rendered
   *  with --strict-mcp-config, so the profileless agent sees exactly these). */
  extraMcpServers?: Record<string, McpServerConfig>;
```

- [ ] **Step 3: Verify the existing seam tests + types still hold**

The seam's null/empty behavior is already covered by `resolveMcpConfigJson` and `mergeMcpServers` unit tests. Confirm nothing regressed and the types compile:

Run: `npx vitest run test/daemon-render.test.ts && npx tsc --noEmit && echo TSC_OK`
Expected: all daemon-render tests PASS and `TSC_OK` prints (no type errors from the seam change).

- [ ] **Step 4: Commit**

```bash
git add daemon/runner.ts
git commit -m "feat: resolve Composio extraMcpServers at the spawn seam even with no profile"
```

---

### Task 3: auto-claim fetches connections for profileless spawns

**Files:**
- Modify: `daemon/auto-claim.ts:118-119` (the comment + the `fetchComposioMcpServers` call)

- [ ] **Step 1: Implement — drop the fetch guard**

In `daemon/auto-claim.ts`, the current lines 118-119 read:

```ts
  // Auto-feed the project's ACTIVE Composio connections as MCP servers (profileless spawns skip it).
  const extraMcpServers = profile ? await fetchComposioMcpServers(a.project, runId, log) : undefined;
```

Replace with:

```ts
  // Auto-feed the project's ACTIVE Composio connections as MCP servers — profiled and profileless
  // spawns alike (a profileless spawn renders them with --strict-mcp-config; see planSpawn).
  const extraMcpServers = await fetchComposioMcpServers(a.project, runId, log);
```

`fetchComposioMcpServers` is already non-fatal (logs + returns `undefined` on CLI failure), and `spawnExecutor`'s render-throw is already caught by auto-claim's existing try/catch (which fails the run cleanly) — so the inherited `MissingEnvError` fail-closed path needs no new handling.

- [ ] **Step 2: Verify types compile + the full daemon test set is green**

Run: `npx tsc --noEmit && npx vitest run test/daemon-render.test.ts && echo OK`
Expected: no type errors; daemon-render tests PASS; `OK` prints.

- [ ] **Step 3: Commit**

```bash
git add daemon/auto-claim.ts
git commit -m "feat: auto-claim feeds Composio connections to profileless spawns"
```

---

### Task 4: Full verification + lint

**Files:** none (gates only)

- [ ] **Step 1: Lint the changed files** (the repo's `npm run lint` is a broken no-op gate — invoke eslint directly)

Run: `npx eslint daemon/render-profile.ts daemon/runner.ts daemon/auto-claim.ts test/daemon-render.test.ts && echo ESLINT_CLEAN`
Expected: `ESLINT_CLEAN`.

- [ ] **Step 2: Full test suite** (real-Neon tests included; the changes are pure/argv-only but prove no regression)

Run: `npx vitest run`
Expected: all test files pass; total = current baseline + 1 (the new `--mcp-config` null-branch test).

- [ ] **Step 3: Final typecheck**

Run: `npx tsc --noEmit && echo TSC_CLEAN`
Expected: `TSC_CLEAN`.

---

## Manual smoke (live-validate, post-merge or pre-PR)

Reaching the null branch requires NO matching rule AND no default profile (otherwise `resolveProfileForTask` always returns one). Steps:

1. Note the current default: `mc profile list --json` (find `isDefault`). If one is set, clear it for the test window (re-set it after).
2. On a project with an active Linear connection, queue a task and run one pull:
   `npx tsx --env-file=.env.local daemon/auto-claim.ts --project <slug> --once`
3. Confirm in the daemon log: the spawn is profileless (no `profile <slug>` in the spawn line) AND `fed 1 composio server(s) [linear] into run <id>` appears.
4. Restore the default profile if you cleared it.

(The `MC_DAEMON_EXEC` stub short-circuits before the MCP seam, so it exercises the fetch + log path without a real model spawn — use it to validate cheaply.)

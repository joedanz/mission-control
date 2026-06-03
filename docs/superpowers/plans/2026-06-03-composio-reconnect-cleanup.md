# Composio Reconnect Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On reconnect, `connectStart` deletes the previously-stored Composio `connected_account` so it stops leaking server-side.

**Architecture:** Add a pure `orphanedConnectedAccountId` helper, then wire a best-effort `deleteConnection` into `connectStart` (read the existing row before the upsert, revoke the old account after the new one is stored). No schema, no migration, no new files.

**Tech Stack:** TypeScript, Vitest (pure unit tests), Composio v3 HTTP client.

**Approved spec:** `docs/superpowers/specs/2026-06-03-composio-reconnect-cleanup-design.md`

---

## File Structure

- `lib/composio-api.ts` — Composio v3 client + pure helpers. **Change:** add the pure `orphanedConnectedAccountId(existingId, newId)` helper next to `deriveUserId`/`mapStatus`.
- `lib/composio-connections.ts` — connection lifecycle orchestration. **Change:** `connectStart` reads the existing row before initiating and best-effort-deletes the orphaned account after the upsert.
- `test/composio-api.test.ts` — pure helper tests. **Change:** add `orphanedConnectedAccountId` cases.

Do the pure helper + its tests first (Task 1, the gate), then the orchestration wiring (Task 2).

---

### Task 1: Pure `orphanedConnectedAccountId` helper

**Files:**
- Modify: `lib/composio-api.ts` (add after `mapStatus`, ~line 39)
- Test: `test/composio-api.test.ts` (add to the `describe('Composio API pure helpers', …)` block)

- [ ] **Step 1: Write the failing tests**

In `test/composio-api.test.ts`, add `orphanedConnectedAccountId` to the import from `../lib/composio-api`:

```ts
import {
  deriveUserId, mapStatus, orphanedConnectedAccountId,
  createAuthConfig, createMcpServer, initiateConnection, getConnectionStatus, deleteConnection,
  ComposioApiError,
} from '../lib/composio-api';
```

Then add this `it` inside the existing `describe('Composio API pure helpers', () => { … })` block (right after the `maps Composio statuses` test):

```ts
  it('picks the orphaned connected_account to revoke on reconnect', () => {
    expect(orphanedConnectedAccountId('ca_old', 'ca_new')).toBe('ca_old');
    expect(orphanedConnectedAccountId('ca_same', 'ca_same')).toBeNull();
    expect(orphanedConnectedAccountId(null, 'ca_new')).toBeNull();
    expect(orphanedConnectedAccountId(undefined, 'ca_new')).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/composio-api.test.ts -t "orphaned"`
Expected: FAIL — `orphanedConnectedAccountId is not a function` (not yet exported).

- [ ] **Step 3: Implement the helper**

In `lib/composio-api.ts`, immediately after the `mapStatus` function (it ends at the line `}` following the `switch`), add:

```ts
/** The prior connected_account to revoke on reconnect: the stored id when it exists and differs
 *  from the freshly-created one, else null (nothing to clean up). Pure. */
export function orphanedConnectedAccountId(existingId: string | null | undefined, newId: string): string | null {
  return existingId && existingId !== newId ? existingId : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/composio-api.test.ts -t "orphaned"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/composio-api.ts test/composio-api.test.ts
git commit -m "feat: orphanedConnectedAccountId pure helper for reconnect cleanup"
```

---

### Task 2: Wire best-effort cleanup into `connectStart`

**Files:**
- Modify: `lib/composio-connections.ts:7` (import the new helper) and `connectStart` (lines 31-41)

- [ ] **Step 1: Import the helper**

In `lib/composio-connections.ts`, the API-client import (line 7) currently reads:

```ts
import { createAuthConfig, createMcpServer, initiateConnection, getConnectionStatus, deleteConnection, deriveUserId, mapStatus, ComposioApiError } from './composio-api';
```

Add `orphanedConnectedAccountId`:

```ts
import { createAuthConfig, createMcpServer, initiateConnection, getConnectionStatus, deleteConnection, deriveUserId, mapStatus, orphanedConnectedAccountId, ComposioApiError } from './composio-api';
```

(`getConnection` is already imported from `./composio-store` on line 6.)

- [ ] **Step 2: Read the existing row + revoke the orphan in `connectStart`**

In `lib/composio-connections.ts`, the current `connectStart` body (lines 32-40) reads:

```ts
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  const { authConfigId } = await ensureToolkit(toolkitSlug);
  const userId = deriveUserId(projectId);
  const { redirectUrl, connectedAccountId } = await initiateConnection(authConfigId, userId);
  const connection = await upsertConnection(projectId, toolkitSlug, {
    userId, connectedAccountId, status: 'initializing', linkUrl: redirectUrl, error: null,
  });
  return { linkUrl: redirectUrl, connection };
```

Replace it with (read `existing` before initiating; revoke the orphan after the upsert):

```ts
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  const { authConfigId } = await ensureToolkit(toolkitSlug);
  const existing = await getConnection(projectId, toolkitSlug); // capture the prior account before the upsert overwrites it
  const userId = deriveUserId(projectId);
  const { redirectUrl, connectedAccountId } = await initiateConnection(authConfigId, userId);
  const connection = await upsertConnection(projectId, toolkitSlug, {
    userId, connectedAccountId, status: 'initializing', linkUrl: redirectUrl, error: null,
  });
  // Revoke the prior connected_account so reconnects don't leak it at Composio. Best-effort: the new
  // connection already succeeded, so a cleanup failure must not fail the reconnect (worst case the old
  // account lingers — today's status quo).
  const orphaned = orphanedConnectedAccountId(existing?.connectedAccountId, connectedAccountId);
  if (orphaned) {
    try {
      await deleteConnection(orphaned);
    } catch (e) {
      console.warn(`composio reconnect: failed to delete orphaned account ${orphaned}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { linkUrl: redirectUrl, connection };
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit && echo TSC_OK`
Expected: `TSC_OK` (the helper signature matches; `existing?.connectedAccountId` is `string | null | undefined`).

- [ ] **Step 4: Commit**

```bash
git add lib/composio-connections.ts
git commit -m "feat: connectStart revokes the orphaned connected_account on reconnect"
```

---

### Task 3: Full verification + lint

**Files:** none (gates only)

- [ ] **Step 1: Lint the changed files** (`npm run lint` is a broken no-op gate — invoke eslint directly)

Run: `npx eslint lib/composio-api.ts lib/composio-connections.ts test/composio-api.test.ts && echo ESLINT_CLEAN`
Expected: `ESLINT_CLEAN`.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all files pass; total = baseline + 1 (the new `orphaned` test).

- [ ] **Step 3: Final typecheck**

Run: `npx tsc --noEmit && echo TSC_CLEAN`
Expected: `TSC_CLEAN`.

---

## Manual smoke (live-validate, pre-PR)

The `connectStart` orchestration has no direct unit test, so prove the wiring against the real Composio API:

1. Pick a project + toolkit with an existing connection. Record the current account id:
   `mc composio list <slug> --json` → note the toolkit's `connectedAccountId` (call it `OLD`).
2. Reconnect: `mc composio connect <slug> <toolkit>` (authorize the hosted link if it requires it — do NOT authorize on the user's behalf; ask them if an auth wall appears).
3. Confirm a NEW id: `mc composio list <slug> --json` → `connectedAccountId` differs from `OLD`.
4. Confirm `OLD` is revoked at Composio: a `GET /connected_accounts/<OLD>` (via a quick script using the existing client, or the Composio dashboard) returns 404 / not found.
5. The `console.warn` path is exercised only on a delete failure; no need to force it.

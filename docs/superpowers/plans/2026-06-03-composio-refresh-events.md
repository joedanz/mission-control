# Composio Connection Refresh + Change Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `mc composio refresh <slug>` re-polls every connection's live Composio status, persists changes, and emits a `composio.connection_changed` event on each transition.

**Architecture:** New event type (enum entry, no migration) → pure `transitionEvent` helper → `refreshConnections` orchestration (poll + persist + best-effort event) → `mc composio refresh` CLI command + SPEC entry.

**Tech Stack:** TypeScript, Vitest (pure unit tests), Composio v3 HTTP client, Commander CLI.

**Approved spec:** `docs/superpowers/specs/2026-06-03-composio-refresh-events-design.md`

---

## File Structure

- `lib/db/schema.ts` — add `'composio.connection_changed'` to `EVENT_TYPES`.
- `lib/composio-api.ts` — pure `transitionEvent` helper (db-free).
- `lib/composio-connections.ts` — `refreshConnections` orchestration + `ConnectionRefresh` type.
- `cli/index.ts` — `composio refresh` command + its `SPEC` entry.
- `test/composio-api.test.ts` — pure `transitionEvent` tests.

Order: event type (Task 1) → pure helper + tests (Task 2, the gate) → orchestration (Task 3) → CLI (Task 4) → verify (Task 5).

---

### Task 1: Add the `composio.connection_changed` event type

**Files:**
- Modify: `lib/db/schema.ts` (the `EVENT_TYPES` array, ends with `'note',` then `] as const;`)

- [ ] **Step 1: Add the enum entry**

In `lib/db/schema.ts`, the `EVENT_TYPES` array currently ends:

```ts
  'tool_call',
  'note',
] as const;
```

Insert the new type before `'note'`:

```ts
  'tool_call',
  'composio.connection_changed',
  'note',
] as const;
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit && echo TSC_OK`
Expected: `TSC_OK` (the `type` column is text; no migration needed).

- [ ] **Step 3: Commit**

```bash
git add lib/db/schema.ts
git commit -m "feat: add composio.connection_changed event type"
```

---

### Task 2: Pure `transitionEvent` helper

**Files:**
- Modify: `lib/composio-api.ts` (add after `orphanedConnectedAccountId`; extend the type-only schema import)
- Test: `test/composio-api.test.ts` (add to the `describe('Composio API pure helpers', …)` block)

- [ ] **Step 1: Write the failing tests**

In `test/composio-api.test.ts`, add `transitionEvent` to the import from `../lib/composio-api`:

```ts
import {
  deriveUserId, mapStatus, orphanedConnectedAccountId, transitionEvent,
  createAuthConfig, createMcpServer, initiateConnection, getConnectionStatus, deleteConnection,
  ComposioApiError,
} from '../lib/composio-api';
```

Add this `it` inside the existing `describe('Composio API pure helpers', () => { … })` block (after the `orphaned` test):

```ts
  it('maps a connection status transition to an event (or null)', () => {
    expect(transitionEvent('proj', 'linear', 'active', 'active')).toBeNull();
    expect(transitionEvent('proj', 'linear', 'expired', 'active')).toEqual({
      level: 'info',
      summary: 'linear connection recovered — now active',
    });
    const expired = transitionEvent('proj', 'linear', 'active', 'expired');
    expect(expired?.level).toBe('warn');
    expect(expired?.summary).toContain('linear connection expired');
    expect(expired?.summary).toContain('mc composio connect proj linear');
    expect(transitionEvent('proj', 'slack', 'active', 'error')?.level).toBe('warn');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/composio-api.test.ts -t "transition"`
Expected: FAIL — `transitionEvent is not a function`.

- [ ] **Step 3: Implement the helper**

In `lib/composio-api.ts`, the top type-only import currently reads:

```ts
import type { ConnectionStatus } from './db/schema';
```

Extend it to also import `EventLevel`:

```ts
import type { ConnectionStatus, EventLevel } from './db/schema';
```

Then add, immediately after the `orphanedConnectedAccountId` function:

```ts
/** The event (if any) for a connection status transition. Null when nothing changed. A move to
 *  'active' is an info recovery; any other move is a warn that names the re-auth command. Pure. */
export function transitionEvent(
  projectSlug: string,
  toolkitSlug: string,
  from: ConnectionStatus,
  to: ConnectionStatus,
): { level: EventLevel; summary: string } | null {
  if (from === to) return null;
  if (to === 'active') return { level: 'info', summary: `${toolkitSlug} connection recovered — now active` };
  return { level: 'warn', summary: `${toolkitSlug} connection ${to} — re-auth needed (mc composio connect ${projectSlug} ${toolkitSlug})` };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/composio-api.test.ts -t "transition"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/composio-api.ts test/composio-api.test.ts
git commit -m "feat: transitionEvent pure helper for connection status changes"
```

---

### Task 3: `refreshConnections` orchestration

**Files:**
- Modify: `lib/composio-connections.ts` (imports + new exported function)

- [ ] **Step 1: Extend imports**

In `lib/composio-connections.ts`:

- Add `transitionEvent` to the `./composio-api` import (line 7), which currently is:
  ```ts
  import { createAuthConfig, createMcpServer, initiateConnection, getConnectionStatus, deleteConnection, deriveUserId, mapStatus, orphanedConnectedAccountId, ComposioApiError } from './composio-api';
  ```
  →
  ```ts
  import { createAuthConfig, createMcpServer, initiateConnection, getConnectionStatus, deleteConnection, deriveUserId, mapStatus, orphanedConnectedAccountId, transitionEvent, ComposioApiError } from './composio-api';
  ```
- Add a `createEvent` import from `./mutations` (new import line, after the `./composio-mcp` import):
  ```ts
  import { createEvent } from './mutations';
  ```
- Add `ConnectionStatus` to the type import from `./db/schema` (line 9), which currently is:
  ```ts
  import type { ComposioConnection, McpServerConfig } from './db/schema';
  ```
  →
  ```ts
  import type { ComposioConnection, ConnectionStatus, McpServerConfig } from './db/schema';
  ```

- [ ] **Step 2: Add the `ConnectionRefresh` type + `refreshConnections` function**

Append to `lib/composio-connections.ts` (after `resolveProjectMcpServers`):

```ts
export type ConnectionRefresh = { toolkitSlug: string; from: ConnectionStatus; to: ConnectionStatus; changed: boolean };

/** Re-poll every linked connection of a project against Composio; persist changes and emit a
 *  composio.connection_changed event per transition (best-effort). A per-connection poll failure is
 *  skipped (status left unchanged) so a transient Composio blip never clobbers a known status. */
export async function refreshConnections(projectSlug: string): Promise<ConnectionRefresh[]> {
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  const conns = await listConnectionsByProject(projectId);
  const results: ConnectionRefresh[] = [];
  for (const conn of conns) {
    if (!conn.connectedAccountId) continue; // never linked → nothing to poll
    const from = conn.status;
    let to = from;
    try {
      to = mapStatus(await getConnectionStatus(conn.connectedAccountId));
    } catch (e) {
      console.warn(`composio refresh: poll failed for ${conn.toolkitSlug} (${conn.connectedAccountId}): ${e instanceof Error ? e.message : e}`);
      results.push({ toolkitSlug: conn.toolkitSlug, from, to: from, changed: false });
      continue;
    }
    if (to !== from) {
      await setConnectionStatus(conn.id, to);
      const ev = transitionEvent(projectSlug, conn.toolkitSlug, from, to);
      if (ev) {
        try {
          await createEvent({ type: 'composio.connection_changed', projectId, level: ev.level, summary: ev.summary });
        } catch (err) {
          console.warn(`composio refresh: event write failed for ${conn.toolkitSlug}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    results.push({ toolkitSlug: conn.toolkitSlug, from, to, changed: to !== from });
  }
  return results;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit && echo TSC_OK`
Expected: `TSC_OK`. (`createEvent`'s `RecordEventInput.type` accepts the new `'composio.connection_changed'`; `level` is `EventLevel`.)

- [ ] **Step 4: Commit**

```bash
git add lib/composio-connections.ts
git commit -m "feat: refreshConnections re-polls + emits change events"
```

---

### Task 4: `mc composio refresh <slug>` command

**Files:**
- Modify: `cli/index.ts` (SPEC entry near line 336 + the command block near the other composio commands)

- [ ] **Step 1: Add the SPEC entry**

In `cli/index.ts`, after the `composio mcp-config` SPEC entry (the line containing `name: 'composio mcp-config'`), add:

```ts
  { name: 'composio refresh', readonly: false, summary: "Re-poll a project's Composio connections; emit events on status changes", args: ['<slug>'] },
```

- [ ] **Step 2: Add the command block**

In `cli/index.ts`, after the `composio mcp-config` command block (the `withFlags(composio.command('mcp-config'))…` block), add:

```ts
withFlags(composio.command('refresh'))
  .description("Re-poll a project's Composio connections; emit events on status changes")
  .argument('<slug>')
  .action((slug: string, opts: LeafOpts) =>
    emit('composio refresh', opts, async () => {
      ensureDbCredentials();
      const { refreshConnections } = await import('../lib/composio-connections');
      const refreshed = await refreshConnections(slug);
      return {
        data: { refreshed, count: refreshed.length },
        human: () => {
          refreshed.forEach((r) => console.log(`${r.toolkitSlug}: ${r.from}${r.changed ? ` → ${r.to}` : ' (unchanged)'}`));
          const changed = refreshed.filter((r) => r.changed).length;
          console.log(`\n${refreshed.length} connection${refreshed.length === 1 ? '' : 's'}, ${changed} changed`);
        },
      };
    }),
  );
```

- [ ] **Step 3: Verify the SPEC↔command sync test passes**

Run: `npx vitest run test/spec-sync.test.ts && echo SPEC_OK`
Expected: PASS (`SPEC_OK`) — the new SPEC entry matches the registered `composio refresh` command.

- [ ] **Step 4: Commit**

```bash
git add cli/index.ts
git commit -m "feat: mc composio refresh command"
```

---

### Task 5: Full verification + lint

**Files:** none (gates only)

- [ ] **Step 1: Lint the changed files** (`npm run lint` is a broken no-op gate — use eslint directly)

Run: `npx eslint lib/db/schema.ts lib/composio-api.ts lib/composio-connections.ts cli/index.ts test/composio-api.test.ts && echo ESLINT_CLEAN`
Expected: `ESLINT_CLEAN`.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all files pass; total = baseline + 1 (the new `transition` test).

- [ ] **Step 3: Final typecheck**

Run: `npx tsc --noEmit && echo TSC_CLEAN`
Expected: `TSC_CLEAN`.

---

## Manual smoke (live-validate, pre-PR)

The forced active→expired transition can't be triggered without a real token expiry, so validate the loop + persistence + no-op path against the real Composio API:

1. `mc composio refresh bodybymike --json` → for the active `linear` connection, expect `changed: false` and `to === 'active'` (no spurious flip).
2. `mc event list --project bodybymike --json` → confirm **no** new `composio.connection_changed` event was appended by the no-op refresh.
3. (Optional, exercises the loop over multiple rows) run on a project with several connections and confirm each is reported once.

The transition + event-emission path is covered by the `transitionEvent` pure test + the reviewed `refreshConnections` wiring.

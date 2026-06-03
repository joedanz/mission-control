# Composio Reconnect Cleanup — Design Spec

**Deferred item #5 of the Composio Integrations reshape.** Date: 2026-06-03.

## Goal

When `connectStart` reconnects a project's toolkit that already has a stored
`connectedAccountId`, delete the **old** Composio `connected_account` so it stops leaking
server-side. Today every reconnect creates a fresh `connected_account` and overwrites the
stored id with no cleanup, orphaning the previous account at Composio indefinitely.

## Background (what already exists)

`lib/composio-connections.ts` `connectStart` (slice 2):

1. resolves the project + `ensureToolkit` (auth config),
2. `initiateConnection(authConfigId, userId)` → `{ redirectUrl, connectedAccountId }`
   (Composio's `/connected_accounts/link` **creates a new** `connected_account` every call),
3. `upsertConnection(...)` — overwrites the row's `connectedAccountId` with the new one.

The pre-existing `connectedAccountId` (from a prior connect) is discarded from our DB and
never deleted at Composio. `disconnect` already revokes via a 404-tolerant
`deleteConnection` (`lib/composio-api.ts`), which this slice reuses.

The orchestration layer (`composio-connections.ts`) has **no direct unit test** — it
composes network (`composio-api`) + DB (`composio-store`) calls. It is covered indirectly
by `test/composio-route.test.ts` (mocks the whole lib) and validated live (slice 2's connect
flow was proven against the real Composio API). Pure helpers are unit-tested
(`test/composio-api.test.ts`).

## Decision (confirmed with the operator)

**Delete the orphaned account at `connectStart`** (when the new link is initiated),
best-effort. Rationale: the connection row holds a single `connectedAccountId`, so deferring
cleanup until the new account is confirmed active (in `connectPoll`) would require stashing
the prior id — a new column, i.e. schema work that belongs to slice #6. Deleting at
`connectStart` keeps the logic in one place with no schema change. The only cost is a brief
window during an **active** re-auth where neither account is usable (old revoked, new not yet
authorized) — acceptable, since reconnect is an explicit replace and is mostly triggered for
broken (expired/error) connections whose old account is already dead.

## Architecture

One pure helper + a best-effort delete wired into `connectStart`. No schema, no migration,
no new files.

### 1. `lib/composio-api.ts` — pure helper

Add alongside the existing pure helpers (`deriveUserId`, `mapStatus`):

```ts
/** The prior connected_account to revoke on reconnect: the stored id when it exists and
 *  differs from the freshly-created one, else null (nothing to clean up). Pure. */
export function orphanedConnectedAccountId(existingId: string | null | undefined, newId: string): string | null {
  return existingId && existingId !== newId ? existingId : null;
}
```

The `existingId !== newId` guard makes the helper a no-op if the ids ever coincide (they
won't — `link` always mints a new id — but the guard keeps it total and safe).

### 2. `lib/composio-connections.ts` — `connectStart` wiring

- Read the existing row **before** initiating (so the upsert doesn't lose the old id):
  `const existing = await getConnection(projectId, toolkitSlug);`
- After `initiateConnection` + `upsertConnection` (the new connection is now stored),
  compute the orphan and revoke it best-effort:

```ts
const orphaned = orphanedConnectedAccountId(existing?.connectedAccountId, connectedAccountId);
if (orphaned) {
  try {
    await deleteConnection(orphaned);
  } catch (e) {
    console.warn(`composio reconnect: failed to delete orphaned account ${orphaned}: ${e instanceof Error ? e.message : e}`);
  }
}
```

`getConnection` is the existing store read; `deleteConnection` and the new
`orphanedConnectedAccountId` are imported from `composio-api`.

## Data flow (reconnect)

```
connectStart(projectSlug, toolkitSlug)
   ├─ getConnection(projectId, toolkitSlug)         → existing (may hold an old connectedAccountId)
   ├─ ensureToolkit → authConfigId
   ├─ initiateConnection(authConfigId, userId)      → { redirectUrl, connectedAccountId(NEW) }
   ├─ upsertConnection(... connectedAccountId: NEW, status: 'initializing' ...)
   └─ orphaned = orphanedConnectedAccountId(existing?.connectedAccountId, NEW)
         └─ if orphaned: deleteConnection(orphaned)  // best-effort, all errors swallowed + warned
   → { linkUrl, connection }
```

## Error handling

- **Old-account delete fails (any error, incl. non-404):** swallowed + `console.warn`. The new
  connection already succeeded — a cleanup failure must never fail the reconnect. Worst case
  the old account lingers at Composio (today's status quo). This is intentionally *more*
  tolerant than `disconnect`, which re-throws non-404 because there the delete **is** the
  operation.
- **No prior account** (`existing` null or `connectedAccountId` null): `orphaned` is null →
  no delete → `connectStart` behaves exactly as today (back-compat for first-time connects).
- `disconnect`'s own 404-tolerant revoke is unchanged.

## Testing

- **`test/composio-api.test.ts` (pure — the gate):**
  - `orphanedConnectedAccountId('ca_old', 'ca_new')` → `'ca_old'`.
  - `orphanedConnectedAccountId('ca_same', 'ca_same')` → `null`.
  - `orphanedConnectedAccountId(null, 'ca_new')` → `null`.
  - `orphanedConnectedAccountId(undefined, 'ca_new')` → `null`.
- **Manual smoke (live-validate):** on a project with an existing connection (note its
  `connectedAccountId`), run `mc composio connect <slug> <toolkit>` again to reconnect.
  Confirm: (a) the row's `connectedAccountId` is the new one, and (b) the old account is gone
  at Composio (`GET /connected_accounts/<oldId>` → 404). The orchestration wiring has no
  direct unit test, so this is the wiring's real proof (mirrors slice 2).

## Out of scope (still deferred — separate slices)

- OAuth token-expiry / re-auth automation (#4) — detecting EXPIRED and re-initiating.
- Multiple accounts per (project, toolkit) (#6) — the schema slice.

## Files

- **Modified:** `lib/composio-api.ts` (pure helper), `lib/composio-connections.ts`
  (`connectStart` wiring), `test/composio-api.test.ts` (pure tests).
- No new files, no schema change, no migration.

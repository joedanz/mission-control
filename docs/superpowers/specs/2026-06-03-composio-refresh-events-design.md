# Composio Connection Refresh + Change Events — Design Spec

**Deferred item #4 of the Composio Integrations reshape.** Date: 2026-06-03.

## Goal

`mc composio refresh <slug>` re-polls every connection's **live** Composio status, persists
any change, and emits an event on each status transition — so an expired (or recovered)
connection is *detected and surfaced* instead of silently dropping out of auto-feed. The
re-auth action itself remains the existing `connectStart` flow (with slice #5's orphan
cleanup); OAuth consent fundamentally needs a human, so this slice automates the *detect +
notify* half.

## Background (what already exists)

- `connectPoll(projectSlug, toolkitSlug)` polls **one** connection's live status, maps it
  (`mapStatus`), persists it — but only on demand (`mc composio status` / the UI's "Check
  status").
- `resolveProjectMcpServers` filters to `status === 'active'`, so an expired connection is
  silently omitted from a spawned agent's MCP servers with no signal.
- Nothing polls Composio in the background (the reaper recovers crashed *runs*; the scheduler
  runs *check-ins* — neither touches Composio).
- Events: `EVENT_TYPES` (closed, typed) + `createEvent(RecordEventInput)` (surfaced) /
  private `recordEvent` (best-effort). `EventLevel` = `debug|info|warn|error`. The `events`
  `type`/`level` columns are free text, so extending the enum needs no migration.

## Decision (confirmed with the operator)

**Refresh command + change events** (not a background daemon, not spawn-path polling). An
operator — or, later, a cron/scheduler entry the operator adds — runs `mc composio refresh`.
Detection + notification only; re-auth stays the existing connect flow.

## Architecture

One pure helper + one orchestration function + one CLI command + one new event type. No
daemon, no migration, no new files.

### 1. `lib/db/schema.ts` — new event type

Add `'composio.connection_changed'` to the `EVENT_TYPES` array (one line). The `type` column
is text, so no migration; the typed enum keeps the event filterable via `mc event list`.

### 2. `lib/composio-api.ts` — pure helper

Db-free (type-only imports of `ConnectionStatus` + `EventLevel` from `./db/schema`),
unit-testable alongside the existing pure helpers:

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

### 3. `lib/composio-connections.ts` — `refreshConnections` orchestration

```ts
export type ConnectionRefresh = { toolkitSlug: string; from: ConnectionStatus; to: ConnectionStatus; changed: boolean };

/** Re-poll every connection of a project against Composio; persist changes and emit a
 *  composio.connection_changed event per transition. A per-connection poll failure is skipped
 *  (status left unchanged) so a transient Composio blip never clobbers a known status. */
export async function refreshConnections(projectSlug: string): Promise<ConnectionRefresh[]>;
```

Behavior per connection:

- No `connectedAccountId` (never linked) → skip (not in the result).
- Poll `getConnectionStatus(connectedAccountId)` → `mapStatus` = `to`.
  - On any error (network / 404) → `console.warn` and skip (push `{ ..., changed: false }`,
    `to = from`). No guessing a status from an error.
- If `to !== from`: `setConnectionStatus(conn.id, to)`, then emit the `transitionEvent`
  result via `createEvent({ type: 'composio.connection_changed', projectId, level, summary })`
  — wrapped best-effort (`try/catch` + `console.warn`; a telemetry miss must not fail the
  refresh).
- Push `{ toolkitSlug, from, to, changed: to !== from }`.

Unknown project → `NotFoundError('project', slug)` (consistent with the sibling functions).

### 4. `cli/index.ts` — `mc composio refresh <slug>`

- `readonly: false` (it writes status + events). New `SPEC` entry:
  `{ name: 'composio refresh', readonly: false, summary: "Re-poll a project's Composio connections; emit events on status changes", args: ['<slug>'] }`.
- Command mirrors `composio list`/`status`: `ensureDbCredentials()`, dynamic-import
  `refreshConnections`, return `{ data: { refreshed }, human }`. Human output prints one
  `toolkit: from → to` line per connection (marking changed ones).

## Data flow

```
mc composio refresh <slug>
   └─ refreshConnections(slug)
        ├─ getProjectIdBySlug → projectId   (NotFound → exit 3)
        ├─ listConnectionsByProject(projectId)
        └─ for each linked connection:
             ├─ getConnectionStatus(accountId) → mapStatus = to   (poll error → skip + warn)
             ├─ if to !== from: setConnectionStatus(id, to)
             │     └─ transitionEvent(slug, toolkit, from, to)
             │           └─ createEvent({ type:'composio.connection_changed', projectId, level, summary })  (best-effort)
             └─ collect { toolkitSlug, from, to, changed }
   → JSON { refreshed: [...] } / human: toolkit: from → to per line
```

## Error handling

- **Unknown project** → `NotFoundError` → CLI exit 3 / `NOT_FOUND`.
- **Per-connection poll failure** (network, 404) → skipped, status unchanged, `console.warn`.
  Refresh continues with the remaining connections.
- **Event write failure** → swallowed + `console.warn` (best-effort); the status change is
  already persisted.
- **Never-linked connection** (no `connectedAccountId`) → skipped.

## Testing

- **`test/composio-api.test.ts` (pure — the gate):** `transitionEvent` —
  `('p','linear','active','active')` → null; `(…, 'expired','active')` → `{ info, recovered }`;
  `(…, 'active','expired')` → `{ warn, summary includes "re-auth needed (mc composio connect p linear)" }`;
  `(…, 'active','error')` → `{ warn, … }`.
- **`spec-sync`** auto-verifies the new `SPEC` entry matches the registered command.
- **Manual smoke (live-validate):** `mc composio refresh bodybymike` against the real API.
  Confirms the loop + persistence + **no-op path**: an active `linear` connection stays
  `active` with `changed: false` and **no** event is written (`mc event list --project
  bodybymike` shows none added). The active→expired transition + event path cannot be forced
  without a real token expiry, so it is covered by the `transitionEvent` pure test + reviewed
  wiring — stated here as a known live-coverage limit.

## Out of scope (deferred)

- Wiring `refresh` into a cron / the scheduler (an operator can add a schedule entry).
- A background polling daemon (the rejected heavier option).
- Interpreting a 404 as a specific terminal status (kept as skip+warn for now).
- Multiple accounts per (project, toolkit) (#6) — the schema slice.

## Files

- **Modified:** `lib/db/schema.ts` (one enum entry), `lib/composio-api.ts` (pure helper),
  `lib/composio-connections.ts` (`refreshConnections`), `cli/index.ts` (command + SPEC entry),
  `test/composio-api.test.ts` (pure tests).
- No new files, no schema migration.

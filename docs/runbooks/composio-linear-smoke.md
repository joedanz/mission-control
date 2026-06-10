# Runbook: Composio → Linear agent-can-act smoke test

Proves that a `claude` agent spawned by Mission Control's executor can act on a long-tail service
(Linear) through a Composio-hosted MCP server. One-time external setup, then a re-runnable harness.

> **Verified working 2026-06-02** — a `claude` agent created + read back a real Linear issue through
> this loop. Confirms the `claude` CLI accepts Composio's remote-`http` MCP shape with an `x-api-key`
> header.

## Prerequisites
- A Composio account: <https://app.composio.dev>
- A Linear account you can connect.
- `mc` CLI linked (`npm link` from this repo).

### Host requirements (the harness fails without these)
- **`.env.local` must be `chmod 600`** — the `mc` CLI refuses a group/world-readable credential file
  (`CONFIG` error). Run `chmod 600 .env.local`.
- **Set `MC_CLAUDE_BIN` to your real standalone `claude`.** `npm run` / `tsx` prepend
  `node_modules/.bin` to `PATH`, whose `claude` is a bundled `@anthropic-ai/claude-code` shim that
  crashes on init (`Cannot read properties of undefined (reading 'prototype')`, a google-auth error)
  under recent Node. Find the real one with `which -a claude | grep -v node_modules`, then add to
  `.env.local`:
  ```
  MC_CLAUDE_BIN=/absolute/path/to/claude
  ```
  (Daemons/scheduler need this in their launch env too.)

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
2. Allow-list at least: `LINEAR_LIST_LINEAR_TEAMS`, `LINEAR_CREATE_LINEAR_ISSUE`, and a read tool
   (`LINEAR_GET_LINEAR_ISSUE` / `LINEAR_LIST_LINEAR_ISSUES`). (Confirm exact slugs via
   `GET /api/v3/tools?toolkit_slug=linear` — Composio's Linear tools carry a `_LINEAR_` infix.)
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
  - *"emitted a MC_SMOKE_RESULT line but its JSON could not be parsed"* — the agent reached the tools but
    its final line wasn't valid JSON; scroll up to the teed output.
  - *"run did not complete (status=failed)"* with a `Cannot read properties of undefined (reading
    'prototype')` stack in the teed output — `claude` resolved to the broken `node_modules/.bin` shim.
    Set `MC_CLAUDE_BIN` (see Host requirements above) and re-run.
  - *"wrong or hallucinated issue"* — the returned title didn't match the unique marker.

### Out-of-band confirmation
On PASS, open the printed issue URL (or the Composio dashboard / Linear) to eyeball the issue exists.

## Teardown
Delete the smoke issues in Linear when done. To remove the profile: `mc profile rm composio-linear --yes`.

## Slice 4 smoke — profile auto-feed (manual)

Proves a project's ACTIVE Composio connection automatically reaches an auto-claimed agent —
no per-profile MCP wiring. `MC_DAEMON_EXEC` short-circuits the spawn before the MCP seam, so
this real spawn is the only true end-to-end check.

Prerequisites:
- A project (e.g. `bodybymike`) with a `repoPath` set and an **active** Linear connection
  (`mc mcp list <slug>` shows `linear  active`). Connect via the MCP tab or
  `mc mcp connect <slug> linear` → authorize → `mc mcp status <slug> linear`.
- `COMPOSIO_API_KEY` set in the daemon's environment (same requirement as any profile secret).
- A resolvable agent profile for the project (the default profile is fine).

Steps:
1. Confirm the resolved map is non-empty:
   `npm run cli -- mcp config <slug> --json` →
   `data.mcpServers["composio-linear"]` present, `url` ends `?user_id=mc-proj-…`.
2. Queue a task that requires Linear, e.g.:
   `npm run cli -- task add <slug> "List our Linear teams and report their names"`
3. Run one auto-claim pass (permission mode that allows the MCP tool calls):
   `MC_CLAUDE_BIN=/ABS/PATH/TO/claude tsx daemon/auto-claim.ts --project <slug> --once --permission-mode acceptEdits`
4. In the daemon log, confirm the line `fed 1 composio server(s) [linear] into run <id>`.
5. Confirm the run output shows the agent listed the Linear teams (it used the auto-fed tool).

Negative check: with no active connection, step 1 returns `{mcpServers:{}}` and the daemon log
shows no `fed … composio server(s)` line — the spawn is unchanged.

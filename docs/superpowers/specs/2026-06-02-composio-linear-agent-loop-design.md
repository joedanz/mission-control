# Composio Agent-Can-Act Loop (Linear) — Design

**Status:** Approved 2026-06-02
**Slice:** `slice/composio-linear-agent-loop` — first slice of the Integrations-tab reshape
**Type:** Backend-first de-risking proof. No UI.

## Goal

Prove that a `claude` agent spawned through Mission Control's **existing** agent-profile / MCP
plumbing can invoke a real **Composio Linear** toolkit tool and create a Linear issue — and leave
behind a re-runnable smoke harness, CI-safe unit tests, and a setup runbook.

This de-risks the one unknown that gates the whole reshape: that MC's daemon correctly resolves the
Composio secret, writes the temp `--mcp-config`, and the spawned agent loads a remote `http` MCP
server with an auth header and calls its tools. Everything downstream (connect-flow UI, connection
storage, the reshaped Integrations tab) assumes this loop works.

## Background — why this is the right first slice

The Integrations tab today is a dead manual tracker: not even an `integrations` table, just `tasks`
with `kind='integration'` and a needed/pending/done segmented control (`IntegrationControl`). No
live data, no agent connection.

The reshape's eventual job is **not** to re-wrap GitHub/Sentry/Stripe — those are "crown jewels"
that a `claude` agent already drives via first-class CLIs (`gh`, `git`, `stripe`). Composio earns its
place as the broker for the **long tail** — services that lack a good agent-usable CLI (Linear,
Slack, Notion, Calendar, CRMs). A connected long-tail account becomes the MCP config that an agent
profile feeds to spawned agents, so scheduled / auto-claimed agents can actually act on those
services.

Linear is the chosen proof target: conceptually close to MC's own tasks, and "create/update an
issue" is an unambiguous write action.

## Key finding — MC already supports the transport

No new production code is needed for the MCP transport. Verified in-repo:

- `lib/profiles.ts:153-169` — `validateMcpServers` accepts `type` in `['stdio','http','sse','ws']`;
  for non-stdio it requires a `url`. The Composio shape (`type:"http"` + `url` + `headers`) validates.
- `daemon/render-profile.ts` — `resolveMcpConfigJson` deep-resolves `${ENV}` placeholders inside each
  server's `env` and `headers`, then emits `{"mcpServers":{…}}`. The daemon writes that to a
  `0o600` temp file and spawns `claude … --mcp-config <tmpfile> --strict-mcp-config`.
- Secrets are **never** stored in the DB — the profile holds only `${COMPOSIO_API_KEY}`, resolved
  from the spawning process's host env at spawn time.

So this slice is config + harness + tests + docs.

## The loop (4 stages)

1. **Composio setup (one-time, external).** Create a Composio account + `COMPOSIO_API_KEY`. Create a
   Linear *auth config*; connect a Linear account under a chosen `user_id`. Create an *MCP server*
   bound to the Linear toolkit + that auth config, with an allow-list (e.g. `LINEAR_CREATE_ISSUE`,
   `LINEAR_LIST_TEAMS`). Copy the per-user hosted-MCP URL.

2. **MC profile.** An agent profile whose `mcpServers` holds:
   ```json
   { "composio-linear": {
       "type": "http",
       "url": "https://backend.composio.dev/v3/mcp/<SERVER_ID>?user_id=<UID>",
       "headers": { "x-api-key": "${COMPOSIO_API_KEY}" } } }
   ```
   `${COMPOSIO_API_KEY}` resolves from host env at spawn — never persisted.

3. **Spawn via the real executor.** The harness loads the persisted `composio-linear` profile **by
   slug** (created via the runbook's `mc profile add`, so the proof exercises the real DB→render
   path) and spawns a run through the *same* path the daemon uses (`spawnExecutor` / `planSpawn` in
   `daemon/`), with the prompt:
   *"Using your Linear tools, create an issue titled 'MC smoke <marker>'. Report the created issue's
   identifier and URL."* Using the real executor is the point — it proves MC's plumbing, not just
   that `claude` can talk to Composio.

4. **Verify the agent acted.** The prompt makes the agent create the issue with a unique marker **and
   read it back** via a Linear MCP tool, then emit a structured `MC_SMOKE_RESULT` line. The harness
   asserts the parsed title equals the marker — so a pure hallucination can't pass (the marker is
   unguessable and the read-back exercises a real tool). The final, truly out-of-band confirmation is
   a **manual eyeball** of the printed issue URL (or the Composio dashboard). A *programmatic* out-of-
   band read (Composio REST / Linear API) is deliberately deferred — it needs an endpoint/credential
   this proof shouldn't depend on; see Out of scope.

## Components / files

- `scripts/smoke-composio-linear.ts` — env-guarded manual harness. Requires `COMPOSIO_API_KEY` (in the
  host env / `.env.local`) **and** the persisted `composio-linear` profile. It loads `.env.local` via
  the npm script's `tsx --env-file`. If `COMPOSIO_API_KEY` is unset, or the profile is absent / has no
  `mcpServers`, it prints a clear **SKIP** and exits 0 (safe to invoke anywhere). Otherwise it loads
  the profile by slug, spawns via the real executor, asserts the agent created + read back a
  marker-matched issue, and reports the URL for a manual out-of-band eyeball. (The Composio MCP URL is
  baked into the profile's `mcpServers.url` — the harness reads it from there, **not** from an env
  var.)

- `test/composio-mcp-shape.test.ts` — **CI-safe, no network.** Asserts:
  1. `validateMcpServers` accepts the Composio Linear shape.
  2. `resolveMcpConfigJson` renders `{"mcpServers":{…}}` with the `x-api-key` header resolved from a
     stub host env.
  3. It throws `MissingEnvError` when `COMPOSIO_API_KEY` is absent from the host env.
  This permanently guards the linchpin in CI.

- `docs/runbooks/composio-linear-smoke.md` — the setup runbook (plain markdown, not a Holocron MDX
  page, to avoid the known MDX gotchas): Composio account → Linear auth config → connect Linear →
  create MCP server → env vars → the exact `mc profile add …` command (with the `mcpServers` JSON) →
  how to run the harness and interpret SKIP / PASS / each failure mode.

- `.env.example` — Composio block already added (this branch): `COMPOSIO_API_KEY` +
  `COMPOSIO_LINEAR_MCP_URL`, documenting the never-stored / resolved-at-spawn model.

**No new production code.** Tests target the existing plumbing; the only new files are a script, a
test, and a doc.

## Error handling

The harness distinguishes failure modes loudly — never a silent "looks fine":

- Missing `COMPOSIO_API_KEY`, or the `composio-linear` profile absent / without `mcpServers` → **SKIP** (exit 0).
- Spawn/render failure (e.g. `MissingEnvError`, executor error) → fail with the render error.
- `monitorAndFinalize` threw, or the run's terminal status isn't `completed` → fail (the run is ended; no misleading PASS on a timed-out/abandoned run).
- Agent emitted no `MC_SMOKE_RESULT`, or emitted one whose JSON won't parse → fail (distinct messages).
- Parsed issue title ≠ the unique marker, or `issueId`/`url` missing → fail ("wrong or hallucinated issue").
- PASS only when a marker-matched issue was created + read back; the printed URL is then eyeballed out-of-band.

## Testing

- CI: `test/composio-mcp-shape.test.ts` runs in the normal vitest suite (no network, no creds).
- Manual: `scripts/smoke-composio-linear.ts` run once with real creds set in `.env.local`.

## Out of scope (these are the next slices)

- Connect-flow UI; the reshaped Integrations tab itself.
- A connection-storage model (project ↔ Composio connection, per-project `user_id`).
- Multi-service catalog; OAuth UX; token-expiry / re-auth surfacing.
- A `lib/composio.ts` builder primitive — deferred to the connect-UI slice that actually reuses it.
- Wiring `COMPOSIO_API_KEY` into the daemon/scheduler launchd env for *scheduled* agent use (only
  the manual harness env is needed to prove the loop).

## Next slice (preview, not built here)

Once the loop is green: design the connection-storage model (project ↔ Composio connection + per-
project `user_id`) and the reshaped Integrations tab that drives connect flows and auto-feeds the
project's agent-profile `mcpServers`.

## Open assumptions / risks

- **CLI accepts the remote `http` MCP shape with `x-api-key`.** Composio's documented MCP example
  targets the Anthropic *API* (`type:"url"`); the CLI's remote-server schema uses `type:"http"`. The
  endpoint, header, and per-user URL are identical. The smoke harness is precisely the test of this
  assumption — if the CLI rejects the shape, that is the finding, and the next step is adapting the
  config (still config-only, no transport rewrite).
- **Composio free tier** (20k tool calls/mo) is ample for the proof.

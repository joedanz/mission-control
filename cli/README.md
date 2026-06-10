# `mc` — Mission Control CLI

A global, agent-friendly CLI for Mission Control. It reads and writes `projects` and
`tasks` directly against Neon through the scoped **agent** database role. Built for AI agents
(and operators) on both local and remote machines.

It is a thin layer over the same `lib/mutations.ts` core the web app uses — so the CLI and the
dashboard can never drift.

## Install

```bash
npm link          # from this repo → puts `mc` on your PATH
which mc          # confirm
mc --version
```

No build step: `mc` runs the TypeScript source via `tsx` (a devDependency). Any machine that runs
`mc` needs this repo checked out with `node_modules` installed.

## Credentials

`mc` talks to Neon directly. It resolves the connection string in this order:

1. **`AGENT_DATABASE_URL`** in the environment (recommended for remote/CI — inject via your host's
   secret store, no file on disk).
2. **`$MC_ENV_FILE`** — path to a dotenv file.
3. **`~/.config/mc/env`** (honors `$XDG_CONFIG_HOME`).

The credential file **must be `chmod 600`** — `mc` refuses to run if it's group/world-readable.

```bash
mkdir -p ~/.config/mc
printf 'AGENT_DATABASE_URL=postgres://...\n' > ~/.config/mc/env
chmod 600 ~/.config/mc/env
```

- `mc` requires the **scoped** `AGENT_DATABASE_URL`. It will **not** silently fall back to the
  owner/app `DATABASE_URL`. If you really must, set `MC_ALLOW_DATABASE_URL_FALLBACK=1` (not
  recommended — that role may be over-privileged).
- **Never commit this file** and never copy it into the repo.

### Security model

The agent role is scoped at the database layer to `projects` + `tasks` + `runs` + `events` (read/write;
no DELETE on the append-only runs/events) — it **cannot** read auth tables. But **the CLI performs no
sign-in and no email-allowlist check**: anyone holding `AGENT_DATABASE_URL` can read/write all project,
task, run, and event data. Treat the credential as sensitive.

**Rotation:** rotate by changing the Neon role's password — this invalidates every distributed
copy at once:

```sql
ALTER ROLE mc_agent PASSWORD '<new>';
```

Rotate on any suspected leak.

## Output contract

Pass `--json` for machine output. When stdout is **not** a TTY (i.e. piped), JSON is the default,
so agents get JSON automatically. Use `--human` to force text.

In JSON mode, stdout is **exactly one** JSON document; all logs/warnings go to stderr.

```jsonc
// success
{ "ok": true, "command": "project add", "data": { "id": "…", "slug": "…", … } }
// list
{ "ok": true, "command": "project list", "data": { "items": [ … ], "count": 19 } }
// error
{ "ok": false, "command": "project get", "error": { "code": "NOT_FOUND", "message": "…" } }
```

- Mutations return the affected row in `data` (so you get the new `id`).
- Lists return `{ items, count }` (count = total matching; `items` capped by `--limit`, default 50).
  Two high-volume lists — `run list` and `event list` — instead return `count` = rows returned plus a
  `truncated` boolean (true when the page hit `--limit`, i.e. there may be more); they don't pay for a full
  count on every poll. `run list --agent` filters in SQL (before the limit), so it never silently drops matches.
- `data` keys are camelCase matching the schema (`repoPath`, `lastActivityAt`, `liveUrl`).

**Exit codes:** `0` ok · `1` DB/conflict · `2` validation · `3` not-found · `4` config/credentials.

## Self-describing

```bash
mc spec --json      # full command catalog, with readonly:true|false per command
mc enums --json     # valid values for every enum field
```

## Addressing

Projects are addressed by **slug**; tasks by **id** (uuid). Get a task's id from `task add`,
`task list`, or `project get`.

## Commands

```
mc project list [--category <c>] [--status <s>] [--archived active|archived|all] [--search <q>] [--limit <n>]
mc project get <slug>
mc project add --name <n> --category <c> [--status --accent --domain --tech --repo-path --repo-url --live-url --priority --notes --sentry-project --email-provider --email-address --stripe-site]
mc project update <slug> [any add flag; only the flags you pass change]
mc project rm <slug> --yes            # deletes the project and cascades its tasks
mc project set-repo <slug> <path> [url]

mc task list <slug> [--status <s>]
mc task get <id>
mc task add <slug> <label...>
mc task set-status <id> <status>      # todo|in_progress|done — idempotent; prefer over toggle
mc task move <id> [--status <s>] [--top|--after <id>]   # board move: change column and/or reorder within it; --top = claimed next. Refuses a live-claimed task → CONFLICT
mc task toggle <id>
mc task rm <id> --yes
mc task next [--project <slug>]                 # peek the next claimable task (custom, todo, unclaimed/claim-expired) — board order (sort_order), then oldest-first
mc task claim <id> [--run <id>] [--ttl <secs>]  # claim a task for the current run; single-statement, race-safe (loses → CONFLICT exit 1)
mc task import-issues <slug> [--state open|closed|all] [--label <name>] [--limit <n>] [--dry-run]  # self-source: GitHub issues → custom tasks

# Agentic workflows — node graphs (React Flow {nodes,edges}) that chain agent runs + integrations
mc workflow list [--project <slug>]
mc workflow get <slug>
mc workflow create --project <slug> --name <n> [--slug <s>] [--graph <json|@file>] [--description <d>]   # a provided graph is validated (DAG, exactly one trigger, agent nodes need a prompt; {{nodeId.field}} refs must target an edge-connected ancestor); omit --graph for an empty draft. Node types: trigger | agent | integration | branch | gate (the walker runs trigger + agent + integration + branch + gate). Trigger node data = {schedule? | event?} (at most one) — neither = a manual trigger; schedule = {cron? | intervalSec?, timezone?} makes an ACTIVE workflow auto-fire on a cadence (the workflow-daemon enqueues a `cron` run when due, via isDue). Exactly one of cron (croner expr) or intervalSec (≥ 60s); timezone (IANA) applies to cron. Anchor = the last cron run, else updatedAt (so a fresh activation waits for the next real instant); single-flight suppresses a fire while a run is in flight; only status=active fires (`mc workflow activate`). event = {source?, types?} makes an ACTIVE workflow fire from an external webhook: POST /api/workflows/<slug>/webhook, authed by an HMAC over the RAW body (X-Hub-Signature-256: sha256=HMAC-SHA256(WORKFLOW_WEBHOOK_SECRET, body) — one global env secret, GitHub-compatible, never DB-stored). A valid signature enqueues an `event`-trigger run with the JSON body in run.context (the daemon walks it; the web tier never spawns), exposed to the graph as {{trigger.output.*}}. The optional types allowlist is matched against X-GitHub-Event (fallback X-Event-Type) — empty = any. Deliberate non-fires (inactive / not an event trigger / filtered / single-flight) → 200 {fired:false}; bad sig (401) / bad JSON (400) / unknown slug (404) are errors. Agent node data = {prompt (required), profileSlug?, projectSlug?, responseSchema?, onError?}. Integration node data = {toolkit (required; Composio catalog slug linear|slack|…), action (required; one of the toolkit's allowedTools), arguments?, onError?} — a deterministic Composio action, NO LLM (no runs row/spawn), run against the project's `active` connection (mc mcp connect); its response `data` feeds downstream {{node.output.*}} refs. Branch node data = {cases (required; ordered [{name, when:{left, op, right?}}]), onError?} — a deterministic condition pick, NO LLM. First true case wins (none → implicit 'else'); routes to the out-edges whose sourceHandle == the case name, and a node with no active incoming edge is `skipped` (reconvergence with any active edge still runs — OR-join). op ∈ eq|ne|gt|gte|lt|lte|contains|truthy|falsy; left/right may carry {{nodeId.field}} refs resolved type-preserving (numeric compare when both look numeric). Gate node data = {message?, onError?} — a HUMAN approval gate, NO LLM. The walker PAUSES here (the gate step sits 'running'/awaiting, non-terminal, so successors stay blocked) and the run settles to the NEW run status `paused` (reaper-EXCLUDED — waits for a human indefinitely; single-flight-COUNTED — still blocks a duplicate). `mc workflow approve <runId> <nodeId> [--reject]` resumes it (approve → continue; reject → fail the gate, onError applies). DATA PASSING: a prompt OR an integration node's arguments embed {{nodeId.field}} refs resolved from upstream output — {{id.result}} (agent free text), {{id.output[.path]}} (an agent's structured_output OR an integration's response data), {{id.status}}. In integration arguments a sole-ref ("{{i.output.count}}") keeps its raw type; an embedded ref string-splices. responseSchema (JSON Schema) → claude --json-schema → structured_output. onError = halt (default) | continue. An unresolvable ref hard-fails the consuming node.
mc workflow update <slug> [--graph <json|@file>] [--name <n>] [--description <d>]   # the CLI twin of canvas authoring: replace a workflow's graph (and/or rename/re-describe) + bump version. A provided --graph is validated through the SAME validateGraph SSOT as create/run; omit --graph to keep the current graph. The canvas Workflows tab's EDIT mode does the same write via POST {action:'save'}: drag-from-palette to add nodes, drag-to-connect (isValidConnection = the `canConnect` SSOT — no cycle / self-loop / edge-into-a-trigger), a typed-common + `data (JSON)` inspector, Backspace to delete, Save → validateGraph (invalid → inline error, never persisted). Editing is disabled while a run is queued/running/paused.
mc workflow run <slug> [--timeout <sec>] [--max-parallel <n>] [--allow-concurrent] [--async]   # run now. DEFAULT = SYNCHRONOUS (this process owns the walk; short prompts). --async = enqueue a 'queued' run (lib-tier, no spawn) and return; the workflow-daemon (`npm run workflow-daemon`) claims it race-safe + executes off-process (same path as the canvas Run button). CONCURRENT WALK: a ready-set scheduler runs independent nodes in PARALLEL — a node is decidable once ALL its predecessors are terminal (wait-all join), so a fan-out's branches overlap and a merge node waits for every branch; `--max-parallel <n>` caps in-flight nodes (default 4). RUN-ONLY: an agent node opens a real run (cost/heartbeat/feed/cancel) — NO claimable task, so the auto-claim daemon can't race it. A failed node halts the walk (stop launching new; in-flight drain) unless onError='continue'. Graph snapshotted onto the run; single-flight refuses a second run while one is queued OR running unless --allow-concurrent. A dead walker's 'running' run is reaped to 'failed'; a 'queued' run survives a daemon restart.
mc workflow status <runId>                  # the workflow run + its per-node step rows (agent steps link a runs id + captured output); status = queued|running|paused|completed|failed|cancelled
mc workflow cancel <runId>                  # cancel a workflow run. A 'queued' or 'paused' (gate-awaiting) run is marked 'cancelled' outright (daemon won't claim it); a 'running' run gets cancelRequested, propagated to the in-flight agent run (kill-switch)
mc workflow approve <runId> <nodeId> [--reject] [--reason <t>] [--async]  # decide a PAUSED gate + resume (slice 9a). Default = synchronous (record decision + paused→running + walk); --async records the decision + requeues paused→queued for the workflow-daemon (the canvas Approve/Reject button's path — no web spawn). --reject fails the gate step (onError halts/continues). Non-paused run → CONFLICT
mc workflow activate <slug>                 # status → active — a cron/interval trigger then fires on its schedule via the workflow-daemon
mc workflow pause <slug>                    # status → paused
mc workflow webhook-url <slug>              # print the external webhook URL (/api/workflows/<slug>/webhook) + HMAC signing details (X-Hub-Signature-256 over the raw body; secret = WORKFLOW_WEBHOOK_SECRET env; set MC_PUBLIC_BASE_URL for the full URL) for an event-triggered workflow; readonly

# Agent profiles — capability bundles (skills/MCP/model/tools/persona) + auto-routing rules
mc profile list [--enabled] [--runtime claude-code|exec] [--schedulable]   # --schedulable = enabled + scheduled check-ins on
mc profile get <slug>
mc profile add --slug <s> --name <n> [--runtime claude-code|exec] [--model <m>] [--fallback-model <m>] [--daily-budget-micros <n>] [--provider <p>] [--base-url <u>] [--permission-mode plan|acceptEdits|bypassPermissions|default] [--skills a,b] [--mcp-config <json|@file>] [--allowed-tools <csv>] [--disallowed-tools <csv>] [--append-system-prompt <t>] [--env K=V ...] [--exec-template <cmd>] [--match-project <csv>] [--match-category <csv>] [--match-label <regex>] [--priority <n>] [--default] [--disabled] [--schedule-enabled] [--schedule-disabled] [--schedule-project <slug>] [--schedule-interval <sec>] [--schedule-cron <expr>] [--schedule-timezone <tz>] [--check-in-prompt <t|@file>]  # fallback-model = claude --fallback-model + budget-downgrade target; daily-budget-micros caps this profile's same-UTC-day run cost (downgrade once exceeded). SCHEDULED CHECK-INS (≠ liveness heartbeat): enabled needs --schedule-project + exactly one of --schedule-interval/--schedule-cron; the scheduler wakes the profile, runs --check-in-prompt in the project's repo, and the agent self-serves that project's queued tasks. --schedule-interval floors at 60s (each check-in is a paid run); --schedule-cron is evaluated in --schedule-timezone (IANA zone; default = daemon local time, often UTC under launchd). Pass "" to clear a trigger.
mc profile update <slug> [any add flag; only provided change] [--enabled]
mc profile set-default <slug>                # the single global fallback when no rule matches (idempotent)
mc profile checked-in <slug> [--status ok|fail]   # scheduler records a check-in: advances last_check_in_at; ok resets / fail increments consecutive_failures (auto-pauses after 3)
mc profile rm <slug> --yes
mc profile resolve [--project <slug>] [--task <id>] [--label <text>]   # preview auto-routing: matchRules → priority → default

# Skills — the derived (resolvable) catalog + the skills.sh registry (installable) source
mc skill list [--project <slug>]             # skills RESOLVABLE to agents: ~/.claude/skills + a project work-dir + enabled plugins (the derived catalog)
mc skill search <query...> [--limit <n>]     # search the skills.sh registry for INSTALLABLE skills via the PUBLIC, unauthenticated GET skills.sh/api/search (what `npx skills` uses; the /api/v1/* endpoints need a Vercel OIDC token and are intentionally not used). No DB. Results carry installed=true|false (slug ∈ the local derived catalog). SKILLS_API_URL overrides the origin
mc skill add <target> [--force]              # install a registry skill into ~/.claude/skills/<slug>/ (then the derived catalog + every spawn discovers it). <target> = owner/repo@skill | owner/repo/skill. Content comes from the skill's PUBLIC GitHub repo (subdir resolved from the repo tree → files fetched from raw.githubusercontent → written atomically); needs no skills.sh auth (optional GITHUB_TOKEN only lifts rate limits). Guards: slug name-safety + per-file path-traversal + SKILL.md frontmatter validation, all before any write. CLI-local filesystem action — no DB row, no run. Refuses an already-installed skill unless --force

# Mission Control — runs (agent sessions) + the activity-event log
mc run start --agent <label> [--project <slug>] [--profile <slug>] [--title <t>] [--source hook|cli|cron|manual] [--model <m>] [--session-id <id>] [--work-dir <dir>] [--id <uuid>]
mc run end <id> <status> [--tokens-in <n>] [--tokens-out <n>] [--cache-read <n>] [--cache-write <n>] [--cost-micros <n>] [--authoritative] [--agent <label>]
mc run list [--active] [--agent <label>] [--limit <n>]   # lean rows; use 'run get <id>' for model/source/timing/cache
mc run get <id>                              # one run + its event trail (the full row)
mc run cancel <id>                           # request cancellation (sets cancel_requested; enforced by the PreToolUse kill-switch hook when installed)
mc event add <summary...> --type <t> [--level debug|info|warn|error] [--project <slug>] [--task <id>] [--run <id>] [--agent <label>]
mc event list [--project <slug>] [--run <id>] [--level <min>] [--limit <n>]

# Spend — cost rollup over runs (sums runs.cost_micros, the authoritative per-run total)
mc spend [--group-by project|agent|day|run] [--since <iso>] [--until <iso>] [--project <slug>] [--agent <label>] [--profile <slug>] [--limit <n>]
```

Run `mc enums --json` for the valid `category`, `status`, `accent`, `priority`, task `status`,
plus `runStatus`, `runSource`, `eventType`, `eventLevel`, `runtime`, and
`permissionMode` values.

**Agent profiles & auto-routing.** A profile is a slug-addressed bundle of capabilities (skills, MCP
servers, model, permission mode, tool policy, persona) plus match rules. `mc profile resolve` previews
which profile auto-routing picks for a project/task: of the **enabled** profiles whose `matchRules` apply
(project slug/category, label regex — all ANDed), the highest `--priority` wins; if none match,
the single `--default` profile is the fallback. `runtime=claude-code` renders rich `claude -p` flags;
`runtime=exec` renders `--exec-template` so a profile can drive a **non-Claude** model through any runner.
Secrets are **never stored** — `--env` and `--mcp-config` values use `${ENV_VAR}` placeholders resolved
from the host at spawn (a raw-secret-looking value triggers a soft warning). The daemon consumes this in a
later slice; today profiles are definable, routable, and linkable to a run via `mc run start --profile`.

**Skills: two surfaces.** `mc skill list` is the **derived, resolvable** catalog — what a spawn can actually
discover on disk (the shared existence predicate guarantees catalog == resolvable). `mc skill search` /
`mc skill add` add the **skills.sh registry** as an **install source**: search the public registry, then
land a chosen skill into `~/.claude/skills/` where the derived catalog picks it up unchanged. Discovery uses
the unauthenticated `skills.sh/api/search` endpoint (the documented `/api/v1/*` endpoints require a Vercel
OIDC token, impractical for a local CLI); install content is fetched from the skill's public GitHub repo, so
neither path needs skills.sh credentials. `mc skill add` is the **one** place `mc` writes into `~/.claude` —
a deliberate, scoped extension (the earlier brainstorms deferred remote install for later; this does it).
mc still never hosts or distributes skill content and never edits other user configuration (`enabledPlugins`,
`settings.json`); the registry is just *where you install from*. The OIDC-gated leaderboard/curated browse
(`mc skill catalog`) is deferred.

**Attribution.** State writes (`task set-status`, etc.) and `run`/`event` commands attribute their
audit-log entry to `$MC_AGENT` (default `mc`). Set `MC_AGENT=claude-code` (and `MC_RUN_ID`, written
by the Session hooks) so an agent's actions are grouped under its run. `mc run start` prints the
`runId` to capture into `MC_RUN_ID`. Token/cost on `run` commands are **absolute cumulative** totals
(monotonic — a lower or out-of-order value never regresses them); cost is integer micro-dollars.

**Self-dispatch (Phase 2).** `mc task next` peeks the next claimable task; `mc task claim <id>` atomically
takes it for the current run. The claim is a single-statement conditional write, so concurrent agents
never collide — exactly one wins and the rest get a `CONFLICT` (exit 1). Claiming is **orthogonal to
status**: it doesn't move the task to `in_progress` (do that with `set-status` if you want), and a claim
auto-expires after `CLAIM_TTL_SEC`. A crashed agent's claims free immediately when the reaper abandons its
run, so its work returns to the queue. Loop: `mc task next` → `mc task claim <id>` → work → `set-status done`.
The queue is **priority-ordered**: `getNextClaimableTask` walks `(sort_order, created_at)`, so `mc task move
<id> --top` (or a drag to the top of the board's To Do column) makes a task the next one `mc task next`
returns. `move` refuses a live-claimed task (`CONFLICT`) — a reorder never yanks work from a running agent.

**Self-sourcing (Phase 3).** `mc task import-issues <slug>` fills the queue from a project's GitHub issues
(`gh issue list` under the hood — needs the `gh` CLI authed + a GitHub `repoUrl` on the project). Each open
issue becomes a custom task labeled `#<number> <title>` with the issue URL in `notes`. Idempotent **by issue
number** (re-running imports only new issues, even if a title was edited); `--dry-run` previews without writing.
This closes the source→dispatch→claim→complete loop: imported tasks are immediately claimable via `mc task next`.

## Examples

```bash
# What needs Sentry?
mc project list --json | jq '.data.items[] | .slug'

# Create a project, add a task, mark it done
mc project add --name "Acme" --category client --status testing --tech "Next.js,Neon" --json
mc task add acme "wire up billing" --json
mc task set-status <id> done --json

# Inspect, then delete
mc project get acme --json
mc project rm acme --yes --json

# Mission Control: open a run, log progress, close it (token/cost optional)
RID=$(mc run start --agent claude-code --project acme --title "billing" --json | jq -r .data.id)
mc event add "started stripe wiring" --type note --run "$RID" --project acme --json
mc run end "$RID" completed --tokens-in 4200 --cost-micros 9100 --json
mc event list --project acme --json        # newest-first activity (info+)
mc run list --active --json                # what's running right now

# Spend: where the money went
mc spend --json                            # by project (default), spend-desc
mc spend --group-by agent --json           # by agent label
mc spend --group-by day --since 2026-05-01 --json   # daily burn this month
```

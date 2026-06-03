<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# `mc` — Mission Control CLI (for agents)

`mc` is a global CLI for reading/writing this app's projects + tasks directly against Neon.
Install once: `npm link` (from this repo). Full reference: [`cli/README.md`](cli/README.md).

**Credentials** (resolved in this order): `AGENT_DATABASE_URL` env var → `$MC_ENV_FILE` →
`~/.config/mc/env` (must be `chmod 600`). The CLI refuses to run without the scoped
`AGENT_DATABASE_URL` (no silent fallback to `DATABASE_URL` — opt in with
`MC_ALLOW_DATABASE_URL_FALLBACK=1`). **The CLI has NO sign-in — anyone with the credential writes
with no email allowlist.** It is scoped at the DB layer to `projects` + `tasks` + `runs` + `events`
(read/write; no DELETE on runs/events; no auth tables).

**Output:** always pass `--json` (or pipe — JSON is the default when stdout is not a TTY).
Envelope: `{"ok":true,"command":"...","data":...}` or
`{"ok":false,"command":"...","error":{"code","message","field?"}}`.
Lists return `data:{items,count}`; mutations return the affected row (so you get the new `id`).
Exit codes: `0` ok · `1` DB/conflict · `2` validation · `3` not-found · `4` config/credentials.

**Discover the surface at runtime:** `mc spec --json` (every command, with `readonly` tags) and
`mc enums --json` (valid values for category/status/accent/priority/taskStatus/integration*).

**Addressing:** projects are addressed by **slug**, tasks by **id** (uuid). On VALIDATION errors
the message lists the valid values; on NOT_FOUND it suggests `mc project list`.

```
mc project list [--category --status --archived active|archived|all --search --limit]
mc project get <slug>
mc project add --name <n> --category <c> [--status --accent --domain --tech --repo-path --repo-url --live-url --priority --notes --sentry-project --email-provider --email-address --stripe-site]
mc project update <slug> [any add flag; only provided flags change]
mc project rm <slug> --yes        # cascades tasks; refuses without --yes
mc project set-repo <slug> <path> [url]
mc task list <slug> [--status --kind custom|integration]
mc task get <id>
mc task add <slug> <label...>
mc task set-status <id> <status>  # idempotent — prefer over toggle
mc task move <id> [--status <s>] [--top|--after <id>]  # board move: change column &/or reorder; --top = claimed next; refuses live-claimed → CONFLICT
mc task toggle <id>
mc task rm <id> --yes
mc task next [--project <slug>]                 # next claimable task; board order (sort_order) then FIFO; unclaimed/expired
mc task claim <id> [--run <id>] [--ttl <secs>]  # claim a task for the current run (race-safe; loses → CONFLICT)
mc task import-issues <slug> [--state open|closed|all] [--label <n>] [--limit <n>] [--dry-run]  # GitHub issues → tasks (idempotent by issue #; needs repoUrl + gh CLI)
mc integration set <slug> <type> <status>   # upsert; idempotent
mc integration list <slug>
mc composio catalog                          # list supported Composio toolkits (slug, name, tool count); no DB needed; reads COMPOSIO_API_KEY from host env (never stored)
mc composio connect <slug> <toolkit>         # start a connection; prints OAuth authorize URL; follow up with mc composio status. At most one connection per (project, toolkit)
mc composio status <slug> <toolkit>          # poll Composio and persist connection status (initializing|active|error|expired|disconnected)
mc composio list <slug>                      # list a project's Composio connections and their statuses
mc composio disconnect <slug> <toolkit>      # revoke at Composio and mark disconnected locally
mc composio mcp-config <slug>                # resolve active connections into an mcpServers JSON map (daemons call this at spawn to auto-feed the agent with remote-http MCP servers for Linear/Slack/…)
mc composio refresh <slug>                   # re-poll all of a project's connections; emit composio.connection_changed events on status changes
mc profile list [--enabled] [--runtime claude-code|exec] [--schedulable]   # --schedulable = enabled + scheduled check-ins on (the scheduler's scan)
mc profile get <slug>
mc profile add --slug <s> --name <n> [--runtime claude-code|exec] [--model <m>] [--fallback-model <m>] [--daily-budget-micros <n>] [--provider <p>] [--base-url <u>] [--permission-mode plan|acceptEdits|bypassPermissions|default] [--skills a,b] [--mcp-config <json|@file>] [--allowed-tools <csv>] [--disallowed-tools <csv>] [--append-system-prompt <t>] [--env K=V ...] [--exec-template <cmd>] [--match-project <csv>] [--match-category <csv>] [--match-kind <csv>] [--match-label <regex>] [--priority <n>] [--default] [--disabled] [--schedule-enabled] [--schedule-disabled] [--schedule-project <slug>] [--schedule-interval <sec>] [--schedule-cron <expr>] [--schedule-timezone <tz>] [--check-in-prompt <t|@file>]  # capability bundle + auto-routing rules. runtime=exec needs --exec-template (drives non-Claude models). Secrets are ${ENV} placeholders only — never stored. fallbackModel → claude --fallback-model (resilience) + the budget-downgrade target; once dailyBudgetMicros of THIS profile's same-UTC-day run cost is exceeded the daemon renders fallbackModel. SCHEDULED CHECK-INS (≠ the liveness heartbeat): an enabled schedule needs --schedule-project + exactly one of --schedule-interval/--schedule-cron; the scheduler daemon wakes the profile on that cadence, spawns a run in the project's repo with --check-in-prompt, and the agent self-serves that project's queued tasks. --schedule-interval has a floor (>=60s; each check-in is a paid run). --schedule-cron is evaluated in --schedule-timezone (IANA zone, e.g. America/New_York); omit it and the cron resolves in the daemon's local time (often UTC under launchd -> wrong hour). Pass "" to --schedule-interval/--schedule-cron to clear a trigger.
mc profile update <slug> [any add flag; only provided change] [--enabled]
mc profile set-default <slug>                # the single global fallback when no rule matches (idempotent)
mc profile checked-in <slug> [--status ok|fail]   # the scheduler records a check-in: advances last_check_in_at; ok resets / fail increments consecutive_failures (auto-pauses the schedule after 3)
mc profile rm <slug> --yes
mc profile resolve [--project <slug>] [--task <id>] [--label <text>] [--kind custom|integration]  # preview which profile auto-routing picks (matchRules → priority → default)
mc run start --agent <label> [--project <slug>] [--profile <slug>] [--title <t>] [--source hook|cli|cron|manual] [--model <m>] [--session-id <id>] [--work-dir <dir>] [--id <uuid>]
mc run end <id> <status> [--tokens-in <n>] [--tokens-out <n>] [--cache-read <n>] [--cache-write <n>] [--cost-micros <n>] [--agent <label>]
mc run list [--active] [--agent <label>] [--limit <n>]
mc run get <id>                              # one run + its event trail
mc run cancel <id>                           # request cancellation (sets cancel_requested; enforced by the PreToolUse kill-switch hook when installed)
mc event add <summary...> --type <t> [--level debug|info|warn|error] [--project <slug>] [--task <id>] [--run <id>] [--agent <label>]
mc event list [--project <slug>] [--run <id>] [--level <min>] [--limit <n>]
mc spend [--group-by project|agent|day|run] [--since <iso>] [--until <iso>] [--project <slug>] [--agent <label>] [--profile <slug>] [--limit <n>]  # cost rollup over runs (sums runs.cost_micros)
```

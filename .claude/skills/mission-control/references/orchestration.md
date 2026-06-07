# Orchestration: workflows, profiles, MCP

Playbooks for the power-operator surface. These are **goal-oriented** — they name the commands and
the traps, then defer exhaustive schema (every workflow node-data field, every profile flag) to
`mc spec --json`, `mc <group> <sub> --help`, and the full reference in the repo's `AGENTS.md`.

---

## Workflows

A workflow is a DAG of nodes: `trigger` | `agent` | `integration` | `branch` | `gate`. Agent nodes
spawn a real run; integration/branch/gate nodes are deterministic (no LLM). Data flows between nodes
via `{{nodeId.field}}` refs.

```
mc workflow list [--project <slug>]
mc workflow get <slug>
mc workflow create --project <slug> --name <n> [--slug <s>] [--graph <json|@file>] [--description <d>]
mc workflow update <slug> [--graph <json|@file>] [--name <n>] [--description <d>]
mc workflow run <slug> [--async] [--timeout <s>] [--max-parallel <n>] [--allow-concurrent]
mc workflow status <runId>
mc workflow cancel <runId>
mc workflow approve <runId> <nodeId> [--reject] [--reason <t>] [--async]
mc workflow activate <slug>            # start firing on its schedule/event trigger
mc workflow pause <slug>
mc workflow webhook-url <slug>         # event-triggered workflows
```

Playbook:

- **Author from a graph file:** `--graph @graph.json` where the file is `{nodes, edges}` (React-Flow
  shape). It's validated on create/update: must be a DAG, exactly one trigger node, agent nodes need a
  prompt, and every `{{nodeId.field}}` ref must point at an edge-connected ancestor. Omit `--graph`
  for an empty draft.
- **Run sync vs async:** `mc workflow run <slug>` is synchronous by default (this process owns the
  walk, blocks to completion — keep agent prompts short). `--async` writes a `queued` run and returns
  immediately; the `workflow-daemon` claims and executes it off-process (this is what the canvas Run
  button does).
- **Observe:** `mc workflow status <runId>` shows per-node step rows and each agent step's run id +
  captured output. Run status: `queued | running | completed | failed | cancelled | paused`.
- **Gates pause the run.** A `gate` node settles the run to `paused` (a non-terminal status that waits
  indefinitely for a human). Resume with `mc workflow approve <runId> <nodeId>` (or `--reject
  --reason …`, which fails the gate step and applies its `onError`).
- **Triggers:** a trigger node carries at most one of a `schedule` (cron/interval — fires when
  `active`) or an `event` (HMAC-signed webhook). Manual triggers fire only via `mc workflow run` /
  the canvas Run button. A workflow only auto-fires when `status=active` (`mc workflow activate`).
- A single-flight guard refuses a second run while one is `queued`/`running`/`paused` unless
  `--allow-concurrent`.

For the full node-data schema (branch `cases`, integration `toolkit`/`action`, `{{ref}}` resolution
rules, `onError`), read the `mc workflow` section of `AGENTS.md` or `mc workflow create --help`.

---

## Profiles

A profile is a capability bundle + auto-routing rules that decide how an agent spawns for a task.

```
mc profile list [--enabled] [--runtime claude-code|exec] [--schedulable]
mc profile get <slug>
mc profile add --slug <s> --name <n> [--runtime --model --skills a,b --permission-mode --match-project --match-category --match-label --priority --default --schedule-* …]
mc profile update <slug> [any add flag; only provided change] [--enabled]
mc profile set-default <slug>
mc profile resolve [--project <slug>] [--task <id>] [--label <text>]
mc profile rm <slug> --yes
```

Playbook:

- **Auto-routing:** when an agent is spawned for a task, the profile is chosen by match rules
  (`--match-project`, `--match-category`, `--match-label`) → `priority` → the global default. Preview
  the pick with **`mc profile resolve --project <slug>`** before relying on it.
- **Scheduled check-ins:** an enabled schedule (`--schedule-enabled` + `--schedule-project` + exactly
  one of `--schedule-interval`/`--schedule-cron`) wakes the profile on a cadence to self-serve that
  project's queued tasks. Cron is evaluated in `--schedule-timezone` (IANA) — set it, or it resolves
  in the daemon's local time (often UTC under launchd → wrong hour).

### Requiring this skill on a profile (skill-wiring)

Profile `skills` are an **enforced spawn-time contract**: the daemon resolves each declared skill on
disk and **fails the run loudly (`MissingSkillError`) if one is missing**. To make spawned agents use
this skill:

```
mc profile update <profile-slug> --skills mission-control
mc profile resolve --project <project-slug>     # confirm before scheduling
```

`mc profile resolve` reports each skill's `source` (`user` / `project` / `plugin`) or a failure
`reason`, plus a `skillsResolved` flag. **The skill must resolve before you schedule** — otherwise
every spawn for that profile hard-fails.

- The resolver checks the **`user`** scope (`~/.claude/skills/`) and the spawn's **work-dir** scope
  (the *target* repo). It does **not** see this repo's `.claude/skills/` when the agent runs elsewhere.
  That's why this skill is installed at `~/.claude/skills/` via symlink (see `SKILL.md` → Install):
  the `user` scope is present for every spawn, so `mc profile resolve` should show
  `source: user`, `skillsResolved: true`. If it shows a failure `reason`, the symlink is missing — run
  the install step before wiring the profile.

---

## MCP connections

Attach external tool servers to a project. Two sources: **composio** (OAuth-brokered catalog
toolkits) and **remote** (a direct remote-http endpoint, no OAuth).

```
mc mcp catalog [--search <q>] [--limit <n>]
mc mcp connect <slug> <toolkit>          # composio OAuth — prints an authorize URL; then `mc mcp status`
mc mcp add-remote <slug> --name <n> --url <u> [--header K=V …]
mc mcp list <slug>                        # both sources, source-tagged
mc mcp status <slug> <toolkit>
mc mcp config <slug>                      # resolved mcpServers JSON (what a spawn feeds the agent)
mc mcp refresh <slug>
mc mcp disconnect <slug> <toolkit>        # composio
mc mcp remove-remote <slug> <name>        # remote
```

Playbook:

- **Composio** (`connect`): starts an OAuth connection to any catalog toolkit; follow the printed
  authorize URL, then poll `mc mcp status <slug> <toolkit>`. At most one connection per
  (project, toolkit).
- **Remote** (`add-remote`): attaches a direct endpoint immediately (`active`). Idempotent on
  (project, name) — re-adding updates url+headers.
- **Header secrets — `${ENV}` placeholders only.** `--header` values must be `${ENV_VAR}` placeholders
  resolved at spawn time; they are **never stored literally**, and a literal secret value (e.g. a real
  `Authorization=Bearer sk-…`) is **rejected with a `VALIDATION` error**. Never paste a live token —
  use `--header Authorization='Bearer ${MY_TOKEN}'` and ensure `MY_TOKEN` is set in the spawn
  environment before the server is usable.

For the full Composio catalog semantics and `mcp config` collision rules, see the `mc mcp` section of
`AGENTS.md`.

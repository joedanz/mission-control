---
name: mission-control
description: >-
  Drive the Mission Control `mc` CLI to read and write projects, tasks, the board, runs, events,
  spend, workflows, profiles, and MCP connections against Neon. Use whenever the work involves
  Mission Control or the `mc` command — managing or triaging projects/tasks, moving cards on the
  board, checking agent spend, authoring or running workflows, configuring profiles, or attaching
  MCP servers — AND whenever you are an agent that should pick up, work, and complete a Mission
  Control task (discover → claim → log events → end your run with cost). Reach for this even when
  the request doesn't literally say "mc": "what should I work on next", "claim that task", "mark it
  done", "how much did this project cost", "wire up a profile/workflow/integration" in a Mission
  Control context all belong here.
---

# Mission Control (`mc`) CLI

`mc` is the agent-facing CLI for Mission Control. It reads/writes `projects`, `tasks`, `runs`,
`events`, MCP connections, `workflows`, and `profiles` directly against Neon — the same core the
web dashboard uses, so the two never drift.

This skill teaches **judgment and sequencing** (which command, in what order, which traps). It does
**not** reproduce every flag — the CLI describes itself; read it at runtime (Golden Rule 2).

## Golden rules (read these first)

1. **Invoke `mc` plainly — no pipes, no redirects, no `2>&1`.** `mc` prints exactly one JSON
   document to stdout; logs/warnings go to stderr separately. A `Bash(mc:*)` permission grant does
   **not** match `mc task list … | head` or `mc task claim X 2>&1`, so adding a pipe/redirect gets
   you permission-denied and wastes turns. Run `mc task list habitcraft`, not `mc task list habitcraft | jq`.

2. **Discover the surface at runtime — don't guess flags.** Two readonly commands are the source of
   truth (kept in sync with the code by tests):
   - `mc spec --json` → every command, each tagged `readonly` or not.
   - `mc enums --json` → valid values for `category`, `status`, `taskStatus`, `runStatus`,
     `runSource`, `eventType`, `eventLevel`, `priority`, `accent`, `runtime`, `permissionMode`.
   - `mc <group> <sub> --help` → flags for one command.
   When unsure, consult these rather than inventing a flag.

3. **Branch on `error.code`, not the exit code.** Exit `1` is overloaded (CONFLICT, DB, GITHUB,
   COMPOSIO). A lost claim race is `CONFLICT`; a missing row is `NOT_FOUND`; bad input is
   `VALIDATION` (with a `field`). See [references/cli-contract.md](references/cli-contract.md).

## Output contract in brief

Every command returns one JSON envelope:

```json
{ "ok": true,  "command": "task list", "data": { "items": [ … ], "count": 3 } }
{ "ok": false, "command": "task claim", "error": { "code": "CONFLICT", "message": "…" } }
```

- **Lists** → `data: { items, count }`. **Mutations** → `data` is the affected row (with its new `id`).
- **`mc spend` is the exception** → `data: { rows, totals, groupBy, truncated }`, not `{ items, count }`.
- Exit codes: `0` ok · `1` DB/conflict/github/composio · `2` validation · `3` not-found · `4` config/credentials.

Full envelope, exit-code, and credential detail: [references/cli-contract.md](references/cli-contract.md).

## Addressing (easy to mix up)

**Projects are addressed by `slug`; tasks, runs, and events by `id` (uuid).** Harvest task uuids
from `task add` / `task next` / `task list` output. A `NOT_FOUND` usually means you passed a slug
where a uuid was expected (or vice versa).

## Where to go next

| You want to… | Read |
|---|---|
| Pick up, work, and complete a task as an agent (claim → events → end run) | [references/worker-loop.md](references/worker-loop.md) |
| Understand the JSON envelope, exit codes, credentials, runtime discovery | [references/cli-contract.md](references/cli-contract.md) |
| Manage projects, tasks, and the board (CRUD, move/reorder, import issues) | [references/projects-tasks-board.md](references/projects-tasks-board.md) |
| Work with runs, events, and spend (telemetry & cost) | [references/runs-events-spend.md](references/runs-events-spend.md) |
| Author/run workflows, configure profiles, attach MCP servers | [references/orchestration.md](references/orchestration.md) |

When a reference doesn't cover a flag you need, fall back to `mc spec --json` / `mc <group> --help`.

## Install (one-time, per machine)

This skill is versioned in this repo at `.claude/skills/mission-control/`. So that agents spawned
into **any** repo (and every session) can discover it, install it at the user scope with a symlink:

```
ln -sfn "$(pwd)/.claude/skills/mission-control" ~/.claude/skills/mission-control
```

Run that once from the repo root. Edits land in the repo copy; the user-scope entry tracks them.
A profile can then require it via `mc profile update <slug> --skills mission-control`; confirm it
resolves with `mc profile resolve --project <slug>` (expect `source: user`, `skillsResolved: true`)
before scheduling — see [references/orchestration.md](references/orchestration.md).

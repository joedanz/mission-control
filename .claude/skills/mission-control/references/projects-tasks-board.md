# Projects, tasks, and the board

Operator-facing CRUD and board management. Addressing matters here: **projects by `slug`, tasks by
`id` (uuid)** — see `SKILL.md`. For valid enum values (`category`, `status`, `priority`,
`taskStatus`, `accent`) run `mc enums --json`.

## Projects

```
mc project list [--category <c>] [--status <s>] [--archived active|archived|all] [--search <q>] [--limit <n>]
mc project get <slug>
mc project add --name <n> --category <c> [--status --accent --domain --tech --repo-path --repo-url --live-url --priority --notes …]
mc project update <slug> [any add flag; only provided flags change]
mc project set-repo <slug> <path> [url]
mc project rm <slug> --yes
```

- `project add` returns the new row including its generated `slug` — capture it for follow-up commands.
- `project update` is sparse: only the flags you pass change.
- `project rm` **cascades to the project's tasks** and **refuses without `--yes`**. There is no undo
  (it's one of the few destructive commands).

## Tasks

```
mc task list <slug> [--status todo|in_progress|done]
mc task get <id>
mc task add <slug> <label...>
mc task set-status <id> <status>      # idempotent — prefer this
mc task toggle <id>                   # flips done/undone — avoid for agents
mc task rm <id> --yes
```

- **Prefer `set-status` over `toggle`.** `set-status <id> done` is explicit and idempotent (running
  it twice is harmless). `toggle` flips relative to current state, which is ambiguous when you can't
  be sure what the current state is — a classic source of "I marked it done but it went back to todo".
- Harvest task uuids from `task add` / `task list` / `task next` output.
- `task rm` refuses without `--yes`.

## The board (`task move`)

```
mc task move <id> [--status <s>] [--top | --after <other-id>]
```

`task move` changes a task's column (`--status`) and/or its order within the queue:

- `--top` puts it first in board order — i.e. **it becomes the next task `mc task next` hands out**.
- `--after <other-id>` places it directly after another task.
- **`move` refuses a live-claimed task** with `CONFLICT` — a reorder never yanks work out from under
  a running agent. If you get `CONFLICT`, the task is currently claimed; wait or move a different one.

Board order (`sort_order`, then FIFO by creation) is exactly what `mc task next` walks, so the board
*is* the work queue — moving a card to the top is how you say "do this next".

## Import GitHub issues

```
mc task import-issues <slug> [--state open|closed|all] [--label <name>] [--limit <n>] [--dry-run]
```

- Requires the project to have a `repoUrl` set (`mc project update <slug> --repo-url …`) and the `gh`
  CLI installed + authenticated.
- **Idempotent by issue number** — re-running won't duplicate tasks, and it survives issue title edits.
- Use `--dry-run` first to preview what would be created.

# Runs, events, and spend

The observability layer: what ran, what happened, and what it cost. Runs and events are addressed by
`id` (uuid), not slug. Append-only — there is **no DELETE** on runs or events.

## Runs

A run is one agent session. The worker loop ([worker-loop.md](worker-loop.md)) opens and closes it.

```
mc run start --agent <label> [--project <slug>] [--profile <slug>] [--title <t>]
             [--source hook|cli|cron|manual] [--model <m>] [--session-id <id>] [--work-dir <dir>] [--id <uuid>]
mc run end <id> <completed|failed|abandoned> [--tokens-in --tokens-out --cache-read --cache-write --cost-micros] [--authoritative]
mc run list [--active] [--agent <label>] [--limit <n>]
mc run get <id>
mc run cancel <id>
```

- `run start` prints the new `runId` (bare id in human mode) — capture it. Born `running`.
- **`--source` defaults to `cli`.** Set `hook` / `cron` / `manual` appropriately, or spend/attribution
  buckets blur together.
- `--id <uuid>` makes start idempotent (re-running with the same id upserts rather than duplicating).
- `run end` metrics are **absolute cumulative** with a monotonic guard — a lower value never regresses
  the stored total; pass `--authoritative` to set the exact final number. `cost-micros` is integer
  micro-dollars (what `mc spend` sums).
- `run cancel` sets `cancel_requested`; the PreToolUse kill-switch hook (when installed) enforces it
  on the target agent. There is no `run rm`.

## Events

Structured, append-only audit entries. Attach them to a project/task/run for a readable trail.

```
mc event add <summary...> --type <type> [--level debug|info|warn|error] [--project <slug>] [--task <id>] [--run <id>] [--agent <label>]
mc event list [--project <slug>] [--run <id>] [--level <min>] [--limit <n>]
```

- `--type` must be an `eventType` enum value — run `mc enums --json` to see the set (e.g.
  `task.claimed`, `run.started`, `tool_call`, `note`, …). An empty summary is a `VALIDATION` error.
- `--level` defaults to `info`. `event list --level warn` filters to `warn` and above.
- Keep secrets out of summaries — events are stored and surfaced in the dashboard.

## Spend

```
mc spend [--group-by project|agent|day|run] [--since <iso>] [--until <iso>] [--project <slug>] [--agent <label>] [--profile <slug>] [--limit <n>]
```

`spend` rolls up `runs.cost_micros`. **Its envelope is different from every other list** — `data` is:

```json
{ "ok": true, "command": "spend", "data": { "rows": [ … ], "totals": { … }, "groupBy": "project", "truncated": false } }
```

Read `data.totals` for the rollup and `data.rows` for the breakdown — **not** `data.items`/`data.count`
(those don't exist on `spend`). `truncated` signals the `--limit` cut the rows.

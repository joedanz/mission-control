# `mc` contract: output, exit codes, credentials, discovery

The universal backbone every other reference builds on. If you only read one reference, read this.

## The JSON envelope

Every `mc` command emits exactly **one** JSON document on stdout. Logs, warnings, and progress go
to **stderr** — never mixed into the JSON. (This is why Golden Rule 1 says invoke `mc` plainly: you
never need `2>&1` or a pipe to separate them.)

**Success:**

```json
{ "ok": true, "command": "<group sub>", "data": <payload> }
```

**Error:**

```json
{ "ok": false, "command": "<group sub>", "error": { "code": "<CODE>", "message": "<human text>", "field": "<name>" } }
```

`field` appears only on `VALIDATION` errors (it names the offending flag/argument).

### `data` shapes

| Command shape | `data` is | Example |
|---|---|---|
| List (`*.list`, `task next` returns one-or-null) | `{ items: [...], count: N }` | `task list`, `run list`, `event list`, `project list` |
| Mutation (`add`, `update`, `set-status`, `claim`, `move`, `start`, `end`, …) | the affected **row**, camelCase keys, including its new `id` | `task add` → the new task row |
| **`spend`** (special) | `{ rows, totals, groupBy, truncated }` — **not** `{ items, count }` | see [runs-events-spend.md](runs-events-spend.md) |
| `spec` | `{ version, commands, enums }` | runtime discovery |
| `enums` | the enums object | runtime discovery |

`count` is the number of items **returned** (capped by `--limit`, default 50), not a total row count.
When `task next` finds nothing claimable, `data` is `null`.

## Exit codes — and why you branch on `error.code`

| Exit | Meaning | `error.code` values that map here |
|---|---|---|
| `0` | success | — |
| `1` | conflict / DB / external | `CONFLICT`, `DB`, `GITHUB`, `COMPOSIO`, `REGISTRY` |
| `2` | bad input | `VALIDATION` (carries `field`) |
| `3` | missing row | `NOT_FOUND` |
| `4` | config/credentials | `CONFIG` |

**Exit `1` is overloaded** — five very different situations collapse to it. Always read
`error.code` to decide what to do:

- `CONFLICT` on `task claim` → you **lost a race** (another run grabbed it, or you already hold a
  live claim on an unfinished task). Recover by re-fetching `mc task next` — this is normal, not a
  failure to surface.
- `CONFLICT` on `task move` → the task is **live-claimed**; a reorder won't yank work from a running
  agent. Wait or pick another.
- `DB` / `GITHUB` / `COMPOSIO` / `REGISTRY` → a real downstream failure worth surfacing. `REGISTRY` is a
  skills.sh registry failure from the `mc skill` group (`mc skill search` / `mc skill add` — discovery + install).
- `VALIDATION` → fix the offending `field`; the message lists valid values for enum fields.
- `NOT_FOUND` → wrong id/slug (see Addressing in `SKILL.md`); the message suggests `mc project list`.

## JSON vs human output

- `--json` forces JSON; `--human` forces text.
- With neither flag, output is **JSON when stdout is not a TTY** (i.e. piped or captured) and human
  text when interactive. Agents should pass `--json` (or rely on the non-TTY default).
- JSON mode = one JSON doc on stdout, everything else on stderr.

## Runtime discovery (lean on this instead of memorizing)

Two readonly, no-DB commands are authoritative and kept in sync with the code by `test/spec-sync.test.ts`:

- `mc spec --json` → `data.commands[]`, each `{ name, readonly, summary, args?, required?, options? }`,
  plus `data.enums` and `data.version`.
- `mc enums --json` → valid values, keyed: `category`, `status`, `accent`, `priority`, `taskStatus`,
  `runStatus`, `runSource`, `eventType`, `eventLevel`, `runtime`, `permissionMode`.
- `mc <group> <sub> --help` → the flags for a single command.

Prefer these over guessing a flag name — the surface evolves, and these never drift from it.

## Credentials & setup

`mc` talks to Neon directly. Install once from the repo with `npm link` (no build step — it runs the
TypeScript source via `tsx`, so the machine needs the repo checked out with `node_modules`).

Credential resolution order:

1. `AGENT_DATABASE_URL` already in the environment (recommended for CI/remote — inject via a secret store).
2. `$MC_ENV_FILE` (a dotenv path).
3. `~/.config/mc/env` (honors `$XDG_CONFIG_HOME`).

```
mkdir -p ~/.config/mc
printf 'AGENT_DATABASE_URL=postgres://mc_agent:<password>@<host>/<db>\n' > ~/.config/mc/env
chmod 600 ~/.config/mc/env
```

- The credential file **must be `chmod 600`** — `mc` refuses to run if it is group/world-readable
  (`CONFIG`, exit 4).
- `mc` requires the **scoped** `AGENT_DATABASE_URL` and will **not** silently fall back to a broader
  `DATABASE_URL`.

> **DANGER — `MC_ALLOW_DATABASE_URL_FALLBACK=1`.** This flag opts into using `DATABASE_URL` when
> `AGENT_DATABASE_URL` is absent. That role may be the **over-privileged owner** role. An agent must
> **never** set this autonomously — if the scoped credential is missing, fail and surface it to the
> operator instead.

### Security model (state it; don't reproduce secrets)

The agent role (`mc_agent`) is scoped at the database layer to `projects` + `tasks` + `runs` +
`events` (read/write; no DELETE on append-only `runs`/`events`; it cannot read auth tables). **The
CLI performs no sign-in and no email allowlist — anyone holding `AGENT_DATABASE_URL` can read/write
all project/task/run/event data.** Treat the credential as sensitive. For rotation, see the
**Security model** section of `cli/README.md` (`ALTER ROLE … PASSWORD`) rather than duplicating it here.

> **Authoring note for this skill:** every credential/connection example here is a **placeholder**
> (`<password>`, `<host>`). Never commit a real `AGENT_DATABASE_URL`, a real Neon host, a token, or
> an internal identifier into these files — this skill is versioned in a public repo.

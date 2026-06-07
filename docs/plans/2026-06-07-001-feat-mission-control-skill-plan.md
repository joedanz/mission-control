---
title: "feat: Mission Control (`mc`) agent skill"
type: feat
status: completed
date: 2026-06-07
depth: standard
origin: none (solo planning; no upstream brainstorm)
---

# feat: Mission Control (`mc`) agent skill

## Summary

Build a comprehensive Claude Code skill — authored and versioned in-repo, installed at the
`user` scope via symlink so it resolves for every session including cross-repo worker spawns —
that teaches an agent the full `mc`
(Mission Control) CLI workflow — both the **worker loop** (discover → claim → work →
log events → end the run with cost) and the **operator/orchestration** surface (projects,
tasks/board, runs/events/spend, workflows, profiles, MCP connections). The skill uses
progressive disclosure: a lean `SKILL.md` carrying the universal contract and golden rules,
routing to per-domain reference files. It deliberately teaches **judgment and sequencing**
(which command, in what order, which traps) while deferring exhaustive flag enumeration to
`mc spec --json` and `mc <group> --help`, so the skill cannot drift from the CLI. The plan
also produces a skill-creator eval test set so the skill's lift and triggering can be measured
before finalizing.

---

## Problem Frame

`mc` is a powerful but sharp-edged CLI. Its surface is large (8 command groups, dozens of
subcommands) and several of its rules are non-obvious enough to burn agent turns:

- A `Bash(mc:*)` permission grant is silently defeated by appending `2>&1` or a `| head` —
  the single most-observed real failure (a sonnet check-in stalled on exactly this).
- Exit code `1` is overloaded across CONFLICT / DB / GITHUB / COMPOSIO, so a lost claim race
  is indistinguishable from a DB error unless the agent branches on `error.code`.
- Projects are addressed by **slug**, tasks/runs/events by **uuid** — easy to mix up.
- The worker loop has subtle invariants (claim ≠ status change; one in-flight task per run;
  `set-status done` does not release the claim; metrics ratchet monotonically).

Today this knowledge lives in `AGENTS.md` (loaded only inside this repo) and scattered
auto-memory notes. There is no portable, discoverable artifact that teaches an agent — whether
working in this repo or spawned by a profile into another project's repo — how to drive `mc`
correctly. This skill fills that gap.

**Who is affected:** worker agents spawned by profiles/check-ins (self-serving tasks),
operators driving Claude to manage Mission Control, and any future agent that needs to read
or write MC state.

---

## Scope Boundaries

**In scope**
- A single skill `mission-control` authored/versioned in-repo at `.claude/skills/mission-control/` **and installed at the `user` scope** (`~/.claude/skills/mission-control/` via symlink → the repo copy) so it resolves for every session, including cross-repo worker spawns.
- `SKILL.md` + per-domain reference files covering the full `mc` surface as *playbooks*.
- A skill-creator eval test set (`evals/evals.json`) with objectively verifiable assertions, plus a trigger-eval set for description optimization.
- Documentation, inside the skill, of how to make MC-spawned worker agents load it (the profile `skills` contract).

**Out of scope (non-goals)**
- Modifying the `mc` CLI itself (`cli/`, `lib/`) — this is documentation/skill content, not a CLI change. No `spec`/`enums`/`spec-sync.test.ts` churn.
- Mutating a live profile in the database to wire the skill in. The plan *documents* the wiring path and *verifies* resolution read-only; actually editing a production profile is a deployment action the operator takes deliberately.
- Re-deriving the exhaustive flag reference that `mc spec --json` and `AGENTS.md` already provide.

### Deferred to Follow-Up Work
- Running the description-optimization loop (`run_loop.py`) — executed after the skill body is validated and the user agrees it's in good shape (skill-creator's final step).
- A `docs/solutions/` consolidation entry capturing "authoring an agent-facing CLI skill" (via `/ce-compound`) once this lands.
- (The user-scope symlink install is now in-scope — see U8 — not deferred.)

---

## Key Technical Decisions

### KTD1 — Progressive disclosure: lean `SKILL.md` + per-domain reference files
The universal, always-needed material (golden rules, the output/exit-code contract in brief,
runtime discovery, addressing asymmetry, a routing table) lives in `SKILL.md`. Domain detail
loads on demand from `references/*.md`. This keeps the always-present Level-2 context small
while giving unlimited depth per domain — the standard skill pattern, and cheap because
Level-1 metadata is ~100 tokens.

### KTD2 — Teach judgment; defer syntax to `mc spec --json`
The skill's value over `AGENTS.md` is *sequencing and traps*, not a flag dictionary. Reference
files are playbooks ("to do X: these commands in this order; watch for these traps"), and they
point at `mc spec --json`, `mc enums --json`, and `mc <group> --help` for exhaustive,
always-current syntax. Rationale: the CLI's self-description is already guarded against drift by
`test/spec-sync.test.ts`; duplicating the full surface into the skill would create a second
source of truth that rots. (see research: `cli/index.ts:331-431`)

### KTD3 — Versioned in-repo, installed at the user scope (symlink)
The canonical source is versioned in-repo at `.claude/skills/mission-control/` (reviewable, shipped
via PR). It is **installed at the `user` scope** by symlinking `~/.claude/skills/mission-control/`
→ the repo copy (U8). This matters because the profile `skills` resolver (verified against
`daemon/render-profile.ts` / `cli/index.ts`) checks the `user` scope (`~/.claude/skills/`) for
**every** spawn — independent of the worker's target repo — plus the *work-dir* scope (the target
repo, not this one). Installing at the `user` scope therefore makes the skill resolve cleanly for
cross-repo worker spawns, so the PR #43/#44 contract **succeeds** instead of hard-failing with
`MissingSkillError`. The symlink keeps one source of truth (edit in-repo, the user-scope entry
tracks it) while delivering the always-on discovery the worker-agent audience needs. Verify with
`mc profile resolve` (expect `source: user`, `skillsResolved: true`).

### KTD4 — Golden rule #1 is plain invocation
"Run every `mc` command plainly — no `2>&1`, no pipes, no redirects" leads the `SKILL.md`. `mc`
already emits exactly one JSON document to stdout (logs go to stderr), so redirects are both
unnecessary and actively harmful under the `Bash(mc:*)` allow-list. This is the highest-frequency
observed failure, so it earns top billing. (see research: `daemon/schedule.ts` `buildCheckInPrompt` carries the same rule)

### KTD5 — Eval baseline = no-skill; assertions are objectively verifiable
Since this is a brand-new skill, with-skill runs are compared against bare Claude given the same
`mc` task. Assertions key on objectively checkable behavior: correct command + sequence, plain
invocation (no pipes/redirects), correct addressing (slug vs uuid), and branching on `error.code`
rather than exit code. Subjective prose quality is left to human review in the benchmark viewer.

---

## High-Level Technical Design

Skill structure and the routing relationship between `SKILL.md` and the reference files:

```
.claude/skills/mission-control/
├── SKILL.md                         # always loaded on trigger (lean)
│   ├─ frontmatter: name, description (pushy triggering)
│   ├─ Golden rules (plain invocation, runtime discovery, branch on error.code)
│   ├─ Output contract in brief + addressing asymmetry
│   └─ Routing table ───────────────┐
├── references/                      │ loaded on demand
│   ├── cli-contract.md  ◄───────────┤  envelope, exit codes, error.code catalog,
│   │                                │  credentials/setup, runtime discovery deep-dive
│   ├── worker-loop.md   ◄───────────┤  next→claim→work→set-status→event→run end,
│   │                                │  attribution (MC_AGENT/MC_RUN_ID), claim invariants
│   ├── projects-tasks-board.md ◄────┤  project/task CRUD, board move/reorder, import-issues
│   ├── runs-events-spend.md   ◄─────┤  run lifecycle, event logging, spend rollups
│   └── orchestration.md  ◄──────────┘  workflows + profiles (+ skill-wiring) + mcp playbook
└── evals/
    └── evals.json                      skill-creator test prompts + assertions
```

Runtime discovery flow the skill teaches (instead of hardcoding the surface):

```
agent needs a command  →  mc spec --json        (authoritative command list + readonly tags)
agent needs enum values →  mc enums --json       (category/status/taskStatus/…)
agent needs flag detail →  mc <group> <sub> --help
```

---

## Output Structure

New directory hierarchy created by this plan (per-unit `**Files:**` are authoritative):

```
.claude/skills/mission-control/
├── SKILL.md
├── references/
│   ├── cli-contract.md
│   ├── worker-loop.md
│   ├── projects-tasks-board.md
│   ├── runs-events-spend.md
│   └── orchestration.md
└── evals/
    └── evals.json
```

Installed at `~/.claude/skills/mission-control/` as a symlink → the repo path above (U8), so the
skill resolves at the `user` scope for every session (including cross-repo worker spawns).

---

## Implementation Units

### U1. `SKILL.md` — backbone, golden rules, routing

**Goal:** Create the lean entry point: frontmatter that triggers reliably, the golden rules,
the contract in brief, and a routing table to the reference files.

**Requirements:** Advances the core ask (a discoverable, comprehensive `mc` skill); embodies KTD1, KTD2, KTD4.

**Dependencies:** none (but reference filenames must match U2–U6).

**Files:**
- `.claude/skills/mission-control/SKILL.md` (create)

**Approach:**
- Frontmatter `name: mission-control`; `description` written *pushy* per skill-creator guidance — name what it does AND when to use it, covering both worker and operator contexts ("Use whenever working with Mission Control / the `mc` CLI: managing projects, tasks, the board, runs, events, spend, workflows, profiles, or MCP connections; OR when an agent needs to discover/claim/complete a task and log its run — even if the user doesn't say 'mc'"). Keep it tight to avoid over-triggering on the bare words "task"/"project" (see Risks).
- Body sections: **Golden rules** (1: plain invocation — no pipes/redirects; 2: discover at runtime via `mc spec --json` / `mc enums --json` rather than guessing; 3: branch on `error.code`, not exit code); **Output contract in brief** (`{ok,command,data}` success / `{ok:false,...,error:{code,message,field?}}`; lists `{items,count}`; mutations return the affected row with its new `id`); **Addressing** (projects = slug, tasks/runs/events = uuid); **Routing table** mapping intents to reference files.
- Keep under ~150 lines; defer detail to references.

**Patterns to follow:** Any installed skill's `SKILL.md` frontmatter shape (e.g. skill-creator's own). Distill `cli/README.md` "Output contract" and `AGENTS.md` `mc` header — do not copy wholesale.

**Test scenarios (eval coverage — see U7):**
- Covers the *triggering* assertion: a Mission Control task prompt causes the agent to consult the skill.
- Covers `plain-invocation`: agent runs `mc` commands with no `2>&1`/pipe/redirect.
- Covers `error-code-branching`: when a command fails, the agent reads `error.code` (e.g. distinguishes `CONFLICT` from `DB`).
- `Test expectation: behavioral only` — content file; correctness is proven by the U7 eval assertions, not unit tests.

**Verification:** `mc` skill appears in available skills when working in-repo; a worker-loop prompt triggers it; golden rules render correctly. Manual read-through confirms the routing table names match U2–U6 files.

---

### U2. `references/cli-contract.md` — output contract, exit codes, credentials, discovery

**Goal:** The universal backbone every other reference leans on: full envelope examples, the
exit-code map with the overload caveat, the `error.code` catalog, credential setup, and the
runtime-discovery deep-dive.

**Requirements:** Embodies KTD2, KTD4; supports every other unit.

**Dependencies:** U1 (routing target).

**Files:**
- `.claude/skills/mission-control/references/cli-contract.md` (create)

**Approach:**
- **Envelope:** success/error JSON with worked examples; note the `spend` exception (`{rows,totals,groupBy,truncated}` not `{items,count}`).
- **Exit codes:** table `0/1/2/3/4`; emphasize that **1 is overloaded** (CONFLICT, DB, GITHUB, COMPOSIO) so agents must read `error.code`. List the `error.code` values and what each means (esp. `CONFLICT` = lost claim race vs `NOT_FOUND` vs `VALIDATION` with `field`).
- **JSON vs TTY:** `--json` forces JSON; piped = JSON by default; `--human` forces text. JSON mode = exactly one JSON doc on stdout, logs on stderr (reinforces plain-invocation rule).
- **Credentials/setup:** `npm link` install (no build step; needs repo + `node_modules`); resolution order `AGENT_DATABASE_URL` env → `$MC_ENV_FILE` → `~/.config/mc/env`; `chmod 600` requirement; no silent `DATABASE_URL` fallback. Use `~/.config/mc/env` as canonical (this is the public OSS repo — keep deployment-specific paths out). **Authoring rule (applies to every reference file):** all credential/connection examples MUST be placeholders only (e.g. `postgres://mc_agent:<password>@<host>/neondb`) — never a real `AGENT_DATABASE_URL`, Neon host, token, or TICC-internal identifier. Add a one-line note that the credential grants unauthenticated read/write to all project/task/run/event data, and point at `cli/README.md` (Security model) for rotation (`ALTER ROLE`) rather than duplicating it. Document `MC_ALLOW_DATABASE_URL_FALLBACK` only under a clearly-marked **DANGER** framing — it may select the over-privileged owner role; agents must never set it autonomously and should instead surface the missing credential to the operator.
- **Runtime discovery:** how to read `mc spec --json` (`{version,commands,enums}`, `readonly` tags) and `mc enums --json`.

**Patterns to follow:** `cli/README.md` "Credentials"/"Output contract"; `cli/index.ts:37-108` (envelope/classify), `cli/env.ts` (resolution).

**Test scenarios (eval coverage — see U7):**
- `error-code-branching` assertion (CONFLICT vs DB) draws on this file.
- `discovery` assertion: when unsure of a flag, agent runs `mc spec --json` / `mc <group> --help` rather than inventing.
- `Test expectation: behavioral only` — proven via U7 assertions.

**Verification:** Examples match live `mc` output for a sample success and a sample VALIDATION error; exit-code table matches `cli/index.ts` classify(); credential path is `~/.config/mc/env`.

---

### U3. `references/worker-loop.md` — the spawned-agent self-serve loop

**Goal:** The operational heart: the exact loop a worker agent runs, attribution, and the
claim invariants that trip agents up.

**Requirements:** Core worker-loop half of the comprehensive scope.

**Dependencies:** U1, U2.

**Files:**
- `.claude/skills/mission-control/references/worker-loop.md` (create)

**Approach:**
- **The loop:** `mc run start --agent <label> [--project <slug>]` (capture the printed `runId` into `MC_RUN_ID` **first** — daemon-spawned agents inherit it and skip this) → `mc task next [--project <slug>]` → `mc task claim <id>` → (optionally `mc task set-status <id> in_progress`) → work → `mc event add … --type … --run …` → `mc task set-status <id> done` → `mc run end <id> completed --cost-micros …`. Without `run start` first, claims/events have no run to attribute to and the cost rollup breaks.
- **Attribution:** export `MC_AGENT` (e.g. `claude-code`) and `MC_RUN_ID` so writes group under the run; `mc run start --agent <label>` prints the `runId` to capture into `MC_RUN_ID`. Note daemon-spawned agents inherit `MC_RUN_ID` automatically.
- **Claim invariants (the traps):** claim is race-safe (loser → `CONFLICT`, branch accordingly); claim ≠ status change; **one in-flight task per run** (claiming a second unfinished task → `CONFLICT`); `set-status done` does *not* release the claim (lingers up to the 30-min TTL); `--ttl` to extend.
- **Run metrics:** `--tokens-in/out`, `--cache-read/write`, `--cost-micros` are absolute cumulative with a monotonic GREATEST guard; `--authoritative` to set exactly.
- Include one concise end-to-end worked example (point to `docs/runbooks/composio-linear-smoke.md` as a real sequence).

**Patterns to follow:** `cli/index.ts` task/run/event actions; `lib/mutations.ts:433` (claim race-safety), `lib/constants.ts:15` (`CLAIM_TTL_SEC`); `AGENTS.md` worker-loop lines.

**Test scenarios (eval coverage — see U7):**
- Covers `worker-loop-sequence`: given "pick up and complete the next task in project X", agent runs `next` → `claim` → `set-status done` (and ends the run) in the right order, plainly.
- Covers `claim-conflict-handling`: on a `CONFLICT` from claim, agent recognizes a lost race (does not treat it as a fatal DB error) and moves on / re-fetches `next`.
- `Test expectation: behavioral only` — proven via U7 assertions.

**Verification:** A dry read of the loop against `mc spec` shows every command/flag exists; the worked example's command sequence is runnable; claim-conflict guidance matches `cli/index.ts` claim action.

---

### U4. `references/projects-tasks-board.md` — operator CRUD + board

**Goal:** The operator surface for projects and tasks, including board management and GitHub
issue import.

**Requirements:** Operator half of the comprehensive scope (projects/tasks/board).

**Dependencies:** U1, U2.

**Files:**
- `.claude/skills/mission-control/references/projects-tasks-board.md` (create)

**Approach:**
- **Projects:** list/get/add/update/rm/set-repo; key flags; `rm --yes` cascades tasks and refuses without `--yes`.
- **Tasks:** list/get/add/set-status/toggle/rm; **prefer `set-status` (idempotent) over `toggle`** (stateful/ambiguous for agents).
- **Board:** `mc task move <id> [--status] [--top|--after <id>]` — changes column &/or reorders; `--top` = "claimed next"; refuses a live-claimed task (`CONFLICT`) so a reorder never yanks running work.
- **Addressing reminder:** harvest task uuids from `task add`/`task next`/`project get`.
- **`import-issues`:** needs project `repoUrl` + authed `gh`; idempotent by issue number; `--dry-run`.

**Patterns to follow:** `cli/index.ts` project/task actions; `lib/mutations.ts:345,366` (move refusing live-claimed).

**Test scenarios (eval coverage — see U7):**
- Covers `operator-task-create`: "add three tasks to project X and mark the first done" → `task add` (×3, capturing ids) → `task set-status <id> done` (not `toggle`), plainly.
- Covers `addressing`: agent uses the project **slug** for project commands and a task **uuid** for task commands.
- `Test expectation: behavioral only` — proven via U7 assertions.

**Verification:** Commands/flags match `mc spec`; `set-status`-over-`toggle` and slug-vs-uuid guidance are explicit.

---

### U5. `references/runs-events-spend.md` — telemetry & cost

**Goal:** The run lifecycle, structured event logging, and spend rollups — the observability
layer.

**Requirements:** Operator/telemetry half of the comprehensive scope.

**Dependencies:** U1, U2.

**Files:**
- `.claude/skills/mission-control/references/runs-events-spend.md` (create)

**Approach:**
- **Runs:** `run start` (required `--agent`; `--source` default `cli` — set `hook`/`cron` appropriately or attribution blurs; `--id` for idempotent upsert); `run end <id> <terminal-status>` (completed|failed|abandoned) with cumulative monotonic metrics; `run list --active`, `run get`, `run cancel` (sets `cancel_requested`, enforced by the kill-switch hook). Note **no DELETE** on runs.
- **Events:** `event add <summary> --type <t> --level <debug|info|warn|error> [--project --task --run --agent]`; `event list`. Append-only, no DELETE.
- **Spend:** `mc spend [--group-by project|agent|day|run] [--since --until …]` — note the **different envelope** (`{rows,totals,groupBy,truncated}`); it sums `runs.cost_micros`.

**Patterns to follow:** `cli/index.ts` run/event/spend actions; `lib/mutations.ts:730+` (GREATEST guard).

**Test scenarios (eval coverage — see U7):**
- Covers `spend-envelope`: "what did project X cost this week" → `mc spend --group-by project --since …` and the agent parses `data.totals`/`data.rows` (not `data.items`).
- Covers `addressing` (runs/events): agent passes run/event **uuids** to `run get`/`run end`/`event add --run` (not a slug), completing the slug-vs-uuid coverage U1 promises.
- `Test expectation: behavioral only` — proven via U7 expectations.

**Verification:** Spend envelope shape documented correctly (differs from list envelope); metric monotonicity and `--authoritative` noted.

---

### U6. `references/orchestration.md` — workflows + profiles + skill-wiring + MCP

**Goal:** The power-operator orchestration playbook: how to author/run/observe workflows,
manage profiles (including how to make spawned agents load THIS skill), and attach MCP servers —
as goal-oriented playbooks, deferring exhaustive node/flag detail to `mc spec`/`AGENTS.md`.

**Requirements:** Orchestration half of the comprehensive scope; embodies KTD2, KTD3.

**Dependencies:** U1, U2.

**Files:**
- `.claude/skills/mission-control/references/orchestration.md` (create)

**Approach:**
- **Workflows (playbook):** the node-graph model (trigger/agent/integration/branch/gate); author via `mc workflow create --graph @file` (validated DAG, one trigger, agent prompts, `{{nodeId.field}}` refs); run sync vs `--async` (durable, daemon-claimed); observe via `mc workflow status <runId>`; `approve`/`cancel`; `activate`/`pause`; triggers (cron/event/manual). Defer the full node-data schema to `AGENTS.md` / `mc spec`.
- **Profiles (playbook):** auto-routing (matchRules → priority → default); `mc profile resolve --project <slug>` to preview; scheduled check-ins. **Skill-wiring sub-section (KTD3):** to make MC-spawned worker agents load `mission-control`, add it to the profile's `--skills` (the enforced contract — fails the run loudly if missing, flips spawn to `--setting-sources user,project`); verify with `mc profile resolve` (look for the skill's `source` / `skillsResolved`). Frame editing a live profile as an operator action, not something the agent does unprompted.
- **MCP (playbook):** `mc mcp catalog --search`; `mc mcp connect <slug> <toolkit>` (OAuth) vs `mc mcp add-remote` (direct remote-http); `mc mcp list/status/config/refresh/disconnect/remove-remote`. One connection per (project, toolkit). **Header secrets:** `--header` values MUST be `${ENV}` placeholders — a literal secret (e.g. a real `Authorization: Bearer …`) is **rejected with a VALIDATION error** and never stored; teach agents to use `${ENV}` only, never paste a live token, and ensure the env var is set in the spawn environment before the server is usable.

**Patterns to follow:** `AGENTS.md` workflow/profile/mcp blocks (distill, don't copy); `docs/src/profiles.mdx` + `daemon/render-profile.ts` (skills contract).

**Test scenarios (eval coverage — see U7):**
- Covers `profile-skill-wiring`: "make the worker profile use the Mission Control skill" → agent describes/uses `mc profile update <slug> --skills …` + `mc profile resolve` to verify, rather than inventing a non-existent `--skills` flag on `claude -p`.
- Covers `discovery` (orchestration breadth): for an unfamiliar workflow node field, agent consults `mc spec --json` / `AGENTS.md` rather than guessing.
- `Test expectation: behavioral only` — proven via U7 assertions.

**Verification:** Every referenced command exists in `mc spec`; the skill-wiring path matches the PR #43/#44 contract in `daemon/render-profile.ts`; no invented flags.

---

### U7. `evals/evals.json` — eval test set

**Goal:** Author the skill-creator eval test set: realistic prompts spanning the worker loop and
operator surface, with objectively verifiable `expectations`, conformant to the real skill-creator
schema and runnable against the actual demo seed.

**Requirements:** Embodies KTD5; enables the validation gate (Verification Strategy).

**Dependencies:** U1–U6 (expectations reference behaviors the content units teach).

**Files:**
- `.claude/skills/mission-control/evals/evals.json` (create)
- *(No `trigger-evals.json` in the skill dir — see Approach; the trigger-eval set is a workspace artifact authored at the deferred description-optimization step.)*

**Approach:**
- **Use the real skill-creator schema** (skill-creator `references/schemas.md`): a top-level
  `{ "skill_name": "mission-control", "evals": [ { "id", "prompt", "expected_output", "expectations": [<strings>], "files": [] } ] }`. There is **no** `assertions` field — `expectations` is an array of complete, objectively verifiable *statements*, not label tokens.
- 4 prompts a real user/agent would say, mixing both halves — **using slugs that exist in the demo
  seed** (`scripts/seed-demo.ts`: `habitcraft`, `dispatch`, `tempo-cli`, … ; worker profile
  `nightly-checkin`). Confirm the chosen project has claimable tasks (`mc task list <slug>`) before
  finalizing:
  1. *Worker loop:* "Pick up the next task in the `habitcraft` project, do it, and mark it done — track it as a run."
  2. *Operator board:* "Add two tasks to `habitcraft` and move the second one to the top of the queue."
  3. *Telemetry:* "How much has the `habitcraft` project cost this week?"
  4. *Orchestration:* "Make the `nightly-checkin` profile use the Mission Control skill and confirm it resolved."
- Write each `expectations` entry as a full checkable sentence (anchor name → statement), e.g.:
  - *plain-invocation* → "The agent invoked every `mc` command with no `2>&1`, pipe, or redirect."
  - *run-start-first* → "The agent ran `mc run start` (or inherited `MC_RUN_ID`) before claiming a task."
  - *claim-conflict* → "On a `CONFLICT` from `mc task claim`, the agent read `error.code` and treated it as a lost race, not a fatal error."
  - *addressing* → "The agent used the project slug for project commands and task/run uuids for task/run commands."
  - *set-status-over-toggle* → "The agent used `mc task set-status … done`, not `toggle`."
  - *spend-envelope* → "For spend, the agent read `data.totals`/`data.rows`, not `data.items`."
  - *profile-skill-wiring* → "The agent wired the skill via `mc profile update … --skills` + `mc profile resolve`, not an invented `claude -p --skills` flag."
  - *discovery* → "When unsure of a flag, the agent ran `mc spec --json` or `mc <group> --help` rather than guessing."
  - *mcp-header-no-literal-secret* → "When attaching an MCP server, the agent used `${ENV}` header placeholders, never a literal token."
- **Trigger-eval set (deferred to description optimization):** ~20 queries (8–10 should-trigger,
  incl. phrasings that don't say "mc"; 8–10 near-miss should-not-trigger, e.g. "create a Jira
  ticket", "what's on my calendar today", "add a TODO comment in this file"), in skill-creator's
  `{ "query", "should_trigger" }` format. Save it to the skill-creator **workspace**
  (`mission-control-workspace/`) and pass via `run_loop.py --eval-set` — do **not** commit it inside
  the skill directory (a 20-query file there is runtime context bloat with no agent-facing purpose).

**Patterns to follow:** the real skill-creator `evals.json` schema in `references/schemas.md` (the Anthropic plugin skill-creator — see Dependencies); `docs/runbooks/composio-linear-smoke.md` for a realistic `mc` sequence.

**Test scenarios:** This unit *is* the test definition. Validity check: the file parses against the real schema; every `expectations` entry is a complete, objectively gradeable statement mapped to a behavior taught in U1–U6; every prompt's slug exists in the demo seed **and** has claimable tasks (confirm with `mc task list <slug>`).

**Verification:** `evals.json` validates against skill-creator's schema; each expectation is scriptable/objectively gradeable (not vibes); the deferred trigger set (when authored) has balanced should/should-not with genuine near-misses.

---

### U8. Install at the user scope + verify discovery

**Goal:** Make the versioned in-repo skill resolvable at the `user` scope so cross-repo worker
spawns (and every session) discover it, and verify resolution end-to-end.

**Requirements:** Embodies KTD3; unblocks the worker-agent audience.

**Dependencies:** U1 (the skill must exist to symlink).

**Files:**
- `~/.claude/skills/mission-control` (symlink → `.claude/skills/mission-control/` in this repo) — created, not committed
- `.claude/skills/mission-control/SKILL.md` (append a one-line install note) — modify

**Approach:**
- Create the symlink (idempotent): `ln -sfn "$(pwd)/.claude/skills/mission-control" ~/.claude/skills/mission-control`. Document the exact command in `SKILL.md` (or a short install note) so a new machine reproduces it; note the canonical source is the repo path and the user-scope entry just points at it (edits land in one place).
- The symlink is a per-machine deployment step, not a committed artifact (it points at an absolute local path).
- Wiring a *specific* live profile's `--skills` stays out of scope (the operator does that deliberately) — but the skill is now resolvable when they do.

**Patterns to follow:** the `user`-scope resolution path in `daemon/render-profile.ts`; the memory convention "default to `~/.claude/`, not personal repos".

**Test scenarios:**
- Covers `discovery-user-scope`: with the symlink present, `mc profile resolve --project <seeded-slug>` for a profile that declares `mission-control` reports the skill at `source: user` with `skillsResolved: true` (no failing `reason`).
- `Test expectation: behavioral` — verified via `mc profile resolve`, not a unit test.

**Verification:** `ls -l ~/.claude/skills/mission-control` shows the symlink to the repo path; `mc profile resolve` resolves the skill at `source: user`; a dry profile declaring `mission-control` does not hard-fail.

---

## Verification Strategy

The skill's "tests" are behavioral evals, executed via the **skill-creator** skill once U1–U7
exist (this is why the user invoked skill-creator → ce-plan → ce-work). The validation gate:

1. **Run the eval loop** (skill-creator): for each `evals.json` prompt, spawn a with-skill
   subagent and a baseline (no-skill) subagent in the same turn; capture timing. **Run the baseline
   in a clean work-dir *without* this repo's `AGENTS.md`** — otherwise `AGENTS.md` auto-loads the
   full `mc` surface into the baseline and the measured lift collapses toward zero (the skill's real
   target is the cross-repo case where `AGENTS.md` is absent).
2. **Grade** each run's assertions (script the objectively checkable ones — plain-invocation,
   command sequence, addressing, error.code branching).
3. **Benchmark + viewer:** aggregate into `benchmark.json` and launch `generate_review.py` for
   the human to review outputs and the quantitative pass-rate/time/token deltas.
4. **Iterate** the skill on feedback; re-run.
5. **Description optimization** (deferred follow-up): run `run_loop.py` over `trigger-evals.json`
   to tune the frontmatter `description` for trigger accuracy, then apply `best_description`.

Manual cross-checks during implementation: every command/flag a reference file names must exist
in `mc spec --json`; the credential path is `~/.config/mc/env`; **before merge, search the skill
files for `postgres://` and `https://` and confirm every match is a placeholder, not a real
endpoint** — no PII/secret/TICC-specific paths or real project slugs leak into the (public OSS) repo.
After install (U8), `mc profile resolve` resolves `mission-control` at `source: user`.

**No `mc` CLI gates apply** — this plan touches no `cli/`/`lib/` code, so eslint/Neon tests/
`spec-sync.test.ts` are not in play. (If implementation unexpectedly edits CLI code, run
`npx eslint <files>` — not the broken `npm run lint` no-op — and update SPEC/ENUMS + spec-sync.)

---

## Risks & Mitigations

- **Discovery depends on the user-scope symlink being present (KTD3).** Cross-repo workers resolve
  `mission-control` only because it's installed at `~/.claude/skills/` (symlink). On a machine that
  has the repo but not the symlink, a profile declaring the skill hard-fails with
  `MissingSkillError`. *Mitigation:* U8 creates and verifies the symlink (`mc profile resolve` →
  `source: user`), and documents the one-line install in `SKILL.md` so any new machine reproduces it.
- **Drift from the CLI.** Hardcoded flag lists would rot. *Mitigation:* KTD2 — playbooks defer
  syntax to `mc spec --json`/`--help`; reference files name commands, not exhaustive flag tables.
- **Over-triggering.** "task"/"project" are common words; a greedy description could fire the skill
  on unrelated work. *Mitigation:* tight, context-anchored description + the should-not-trigger
  near-misses in `trigger-evals.json` and the description-optimization pass.
- **Eval prompts need seeded data.** Worker-loop/spend prompts assume a project with tasks.
  *Mitigation:* target the existing demo seed (`scripts/seed-demo.ts`, "Northwind Labs"); mark any
  prompt that needs seeding explicitly.
- **Credential-path confusion.** A memory note records a deployment alias (`ticc-mc`).
  *Mitigation:* document only `~/.config/mc/env` (canonical for this OSS repo); keep the alias out.

---

## Dependencies / Prerequisites

- `mc` on PATH (confirmed: `/Users/danziger/.npm-global/bin/mc`) for live cross-checks and eval runs.
- A seeded project (demo seed) for eval prompts that read/write tasks and spend.
- The **Anthropic plugin** skill-creator harness (`scripts/aggregate_benchmark`, `eval-viewer/generate_review.py`, `run_loop.py`, `references/schemas.md`) — resolved from the `example-skills`/`document-skills` plugin cache, **not** the unrelated `~/.claude/skills/skill-creator` stub (which lacks the scripts/schema). Invoke the plugin one for the validation gate.

---

## Sources & Research

- `cli/index.ts` (dispatch, envelope `:37-108`, SPEC/ENUMS `:317-431`), `cli/env.ts` (credentials), `cli/README.md`.
- `lib/mutations.ts` (claim race-safety `:433`, move-refuses-live-claim `:345,366`, monotonic metrics `:730+`), `lib/constants.ts:15` (`CLAIM_TTL_SEC`).
- `AGENTS.md` `mc` reference (full surface, to distill not copy).
- `docs/src/profiles.mdx`, `daemon/render-profile.ts` (profile `skills` enforced contract, PR #43/#44).
- `daemon/schedule.ts` `buildCheckInPrompt` (plain-invocation rule precedent).
- `docs/runbooks/composio-linear-smoke.md` (worked `mc` sequence).
- Auto-memory: `reference_bash_allowlist_redirect_gotcha`, `reference_claude_code_headless_skill_discovery`, `reference_mission_repo_gates_and_role`, `project_public_oss_mirror`, `project_demo_seed_and_branch`.

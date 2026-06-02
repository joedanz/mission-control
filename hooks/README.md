# Claude Code → Mission Control hooks

Passive telemetry: these hooks open a **run** when a Claude Code session starts, **heartbeat** on each
tool use, and **close** it (with best-effort token totals) when it stops — so the dashboard records
what an agent did without the agent having to remember to log anything.

They post to the `/api/ingest` endpoint and are **best-effort**: if `INGEST_TOKEN` is unset or the
server is unreachable, every hook silently no-ops. A hook never blocks or fails a session.

## Files

| Hook event | Script | Does |
|------------|--------|------|
| `SessionStart` | `session-start.mjs` | `run.start` (client-generated uuid) + write the run id to a cwd-keyed temp file; clears any stale kill-switch flag |
| `PreToolUse` | `pre-tool-use.mjs` | **kill switch** — halts the turn before the next tool if this run was cancelled (reads a local flag; no network) |
| `PostToolUse` | `post-tool-use.mjs` | `run.heartbeat` + a `debug`-level `tool_call` event (kept for replay); caches the heartbeat's `cancel_requested` bit into the local flag |
| `Stop` / `SubagentStop` | `stop.mjs` | `run.end` with token totals summed from the transcript; clears the cwd file + kill-switch flag |

The run id lives in `$TMPDIR/mc-run-<sha1(cwd)>`. `mc` reads the same file (`resolveRunId()`), so
`mc task set-status …` run from that directory attributes its audit-log entry to the live run.

## Kill switch (operator cancel → halt)

`mc run cancel <id>` / the Stop button on `/runs/[id]` set `runs.cancel_requested` (the **write** half,
shipped earlier). Enforcement is here:

1. The `PostToolUse` heartbeat response already round-trips the run row, so it learns `cancel_requested`
   for free. When it's true, `post-tool-use.mjs` writes a local flag at `$TMPDIR/mc-cancel-<sha1(cwd)>`.
2. `pre-tool-use.mjs` reads that flag (a local file check — **no network**, zero cost when not cancelled)
   and, if set, returns `{ "continue": false, "stopReason": … }` which **ends the turn** before the next
   tool runs.

Detection lags by ~one tool call (the heartbeat that learns the cancel runs *after* a tool), which is
fine for a kill switch. **Scope/honesty:** this can only stop **tool-using** work — it can't interrupt a
pure-generation turn or kill the OS process. A genuinely dead process is still the reaper's job (it flips
the run to `abandoned`). Everything is **fail-open**: if the flag can't be read, the tool is allowed —
a kill switch must never wedge a legitimate run.

## Configure

Set these in the environment Claude Code runs hooks with (shell profile, or the `env` block in
settings):

```bash
export INGEST_TOKEN=...                                  # must match the server's INGEST_TOKEN
export MC_INGEST_URL=https://your-app.example.com/api/ingest   # default: http://localhost:3030/api/ingest
export MC_AGENT=claude-code                               # the agent label shown in the fleet
```

Then add the hooks to `~/.claude/settings.json` (or the project `.claude/settings.json`), using the
**absolute path** to this directory:

```json
{
  "hooks": {
    "SessionStart":  [{ "hooks": [{ "type": "command", "command": "node /path/to/mission/hooks/session-start.mjs" }] }],
    "PreToolUse":    [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /path/to/mission/hooks/pre-tool-use.mjs" }] }],
    "PostToolUse":   [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /path/to/mission/hooks/post-tool-use.mjs" }] }],
    "Stop":          [{ "hooks": [{ "type": "command", "command": "node /path/to/mission/hooks/stop.mjs" }] }],
    "SubagentStop":  [{ "hooks": [{ "type": "command", "command": "node /path/to/mission/hooks/stop.mjs" }] }]
  }
}

The `PreToolUse` hook is safe to wire globally: it's a local-file check that no-ops instantly on any
run that hasn't been cancelled, and fail-open on error.
```

## Verify manually

```bash
export INGEST_TOKEN=... MC_INGEST_URL=http://localhost:3030/api/ingest
echo '{"session_id":"s1","cwd":"'"$PWD"'","transcript_path":"","source":"startup"}' | node hooks/session-start.mjs
echo '{"cwd":"'"$PWD"'","tool_name":"Bash"}' | node hooks/post-tool-use.mjs   # heartbeat (and caches cancel bit)
echo '{"cwd":"'"$PWD"'","tool_name":"Bash"}' | node hooks/pre-tool-use.mjs    # prints nothing → tool allowed
echo '{"cwd":"'"$PWD"'","transcript_path":""}' | node hooks/stop.mjs
# then: mc run list --json   (or check the Mission tab)

# Kill switch end-to-end: cancel the run, heartbeat once (caches the flag), then PreToolUse halts:
RID=$(cat "$TMPDIR/mc-run-$(printf %s "$PWD" | shasum | cut -c1-16)")  # or grab it from `mc run list`
mc run cancel "$RID"
echo '{"cwd":"'"$PWD"'","tool_name":"Bash"}' | node hooks/post-tool-use.mjs   # heartbeat sees cancel → writes flag
echo '{"cwd":"'"$PWD"'","tool_name":"Bash"}' | node hooks/pre-tool-use.mjs    # → {"continue":false,...} (halts)
```

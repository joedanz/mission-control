#!/usr/bin/env node
// ABOUTME: Claude Code PostToolUse hook → heartbeat (keeps the run "live") + a debug-level tool_call
// ABOUTME: event retained for replay (filtered out of the info-level activity feed).

import { readStdin, post, resolveRunId, writeCancelFlag, AGENT_LABEL } from './_lib.mjs';

const input = await readStdin();
const cwd = input.cwd || process.cwd();
const runId = resolveRunId(cwd); // MC_RUN_ID (this child's own run) over the shared cwd file
if (!runId) process.exit(0); // no open run for this cwd — nothing to do

const tool = input.tool_name || input.tool || 'tool';

// Bound the per-event payload: a Write/Edit tool_input embeds the ENTIRE file contents, so an unbounded
// `input.tool_input` makes single debug rows tens-to-hundreds of KB — the dominant driver of events-table
// growth. Keep small inputs verbatim (useful for replay); replace an oversized one with a capped preview.
// (Row-COUNT retention is a separate ops decision — events is an append-only audit log and the agent role
// has no DELETE, so a time-based prune needs an owner-role sweep, deferred.)
const MAX_INPUT_CHARS = 4000;
function capToolInput(raw) {
  if (raw == null) return null;
  let s;
  try {
    s = JSON.stringify(raw);
  } catch {
    return { truncated: true, note: 'unserializable tool input' };
  }
  if (s.length <= MAX_INPUT_CHARS) return raw;
  return { truncated: true, bytes: s.length, preview: s.slice(0, MAX_INPUT_CHARS) };
}

// Heartbeat + the (debug) tool_call event are independent — fire them concurrently.
const [hb] = await Promise.all([
  post({ type: 'run.heartbeat', id: runId }),
  post({
    type: 'event',
    agentLabel: AGENT_LABEL,
    runId,
    eventType: 'tool_call',
    level: 'debug', // captured for replay; the feed shows >= info
    summary: `tool: ${tool}`,
    payload: { tool, input: capToolInput(input.tool_input) },
  }),
]);

// The heartbeat response carries the run row (incl. cancel_requested). Cache that bit into a local flag
// so the PreToolUse hook can halt the NEXT tool with no network call of its own. A null response (server
// unreachable / terminal run) leaves any existing flag untouched. We only ever SET here — the flag is
// cleared on session-start (fresh run) and run-end (stop.mjs); cancel_requested is one-way today.
if (hb?.data?.cancelRequested) writeCancelFlag(runId);

process.exit(0);

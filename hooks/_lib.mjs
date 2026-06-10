// ABOUTME: Shared helpers for the Claude Code → Mission Control telemetry hooks. Plain Node ESM
// ABOUTME: (run directly, no build). Every function is best-effort and NEVER throws — a hook must
// ABOUTME: never break or block a Claude Code session.

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { priceMessageMicros } from './pricing.mjs';

export const INGEST_URL = process.env.MC_INGEST_URL || 'http://localhost:3030/api/ingest';
export const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
export const AGENT_LABEL = process.env.MC_AGENT || 'claude-code';

/** Read+parse the hook's JSON payload from stdin (Claude Code writes it there). {} on any problem. */
export async function readStdin() {
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Run id is correlated to the working directory (a fresh `mc` shell shares cwd, not session_id).
// This MUST match cli/index.ts resolveRunId(): sha1(cwd) first 16 hex chars.
function cwdKey(cwd) {
  return createHash('sha1').update(cwd || process.cwd()).digest('hex').slice(0, 16);
}
function runFile(cwd) {
  return join(tmpdir(), `mc-run-${cwdKey(cwd)}`);
}
export function readRunId(cwd) {
  try {
    return readFileSync(runFile(cwd), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** The run THIS hook process belongs to. Prefer the spawn-injected MC_RUN_ID (daemon children — auto-claim,
 *  scheduler, and the workflow walker's parallel agent nodes — each carry their OWN id in env) over the
 *  cwd-keyed file. This MUST mirror cli/index.ts resolveRunId(). Why it matters: multiple children can run in
 *  ONE repo cwd (a workflow fan-out, or a scheduled check-in landing on an auto-claim-locked repo), and the
 *  cwd-keyed file is a single slot they clobber — so a heartbeat/run.end keyed on the FILE attributes to
 *  whichever child wrote last. Keying on MC_RUN_ID gives each child its own identity; interactive sessions
 *  (no MC_RUN_ID, one agent per cwd) fall back to the file exactly as before. */
export function resolveRunId(cwd) {
  return process.env.MC_RUN_ID || readRunId(cwd);
}
export function writeRunId(cwd, id) {
  try {
    writeFileSync(runFile(cwd), id, { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}
export function clearRunId(cwd) {
  try {
    rmSync(runFile(cwd), { force: true });
  } catch {
    /* best-effort */
  }
}

// ── Kill-switch flag (R9 enforcement) ───────────────────────────────────────────
// A LOCAL flag keyed on the RUN ID (not cwd): the PostToolUse heartbeat sets it when the server reports the
// run is cancel_requested (the heartbeat response already round-trips that bit), and the PreToolUse hook
// reads it — with NO network on the hot path — to halt the turn before the next tool. Detection lags by one
// tool call, which is fine for a kill switch, and keeping the check local means it costs nothing on
// uncancelled runs. Cleared on session-start (fresh run) and run-end (stop). Keying on the run id (both
// hooks resolve the SAME id via resolveRunId) means cancelling one of several concurrent children in a repo
// halts only THAT child, and a sibling's session-start can't wipe this run's pending kill-switch.
function cancelFile(runId) {
  return join(tmpdir(), `mc-cancel-${createHash('sha1').update(String(runId)).digest('hex').slice(0, 16)}`);
}
export function readCancelFlag(runId) {
  try {
    return runId ? existsSync(cancelFile(runId)) : false;
  } catch {
    return false; // fail-open: a flag we can't read must never block a tool
  }
}
export function writeCancelFlag(runId) {
  try {
    if (runId) writeFileSync(cancelFile(runId), '1', { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}
export function clearCancelFlag(runId) {
  try {
    if (runId) rmSync(cancelFile(runId), { force: true });
  } catch {
    /* best-effort */
  }
}

/** The PreToolUse stdout payload that HALTS the current turn. Claude Code contract: top-level
 *  `continue:false` ends the turn (the strongest lever a hook has), and the deny block also blocks the
 *  in-flight tool with a reason. This can only stop TOOL-USING work — killing the OS process is the
 *  reaper's job — but that halts all real progress. */
export function killSwitchHalt() {
  return {
    continue: false,
    stopReason:
      'Mission Control kill switch: the operator requested cancellation of this run (mc run cancel / Stop button). Stopping now — do not run any more tools.',
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'run cancel_requested — halting the turn',
    },
  };
}

/** POST a telemetry body to the ingest endpoint. No-op (null) if unconfigured; never throws. */
export async function post(body) {
  if (!INGEST_TOKEN) return null; // not configured → silently do nothing
  try {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INGEST_TOKEN}` },
      body: JSON.stringify(body),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Best-effort sum of token usage + cost from a Claude Code transcript (.jsonl). All fields optional.
 *  `costMicros` is priced PER MESSAGE by that message's own model (a session can switch models, and
 *  runs.model is null), summed via hooks/pricing.mjs. An unknown model contributes 0 cost.
 *
 *  Claude Code writes MULTIPLE lines per assistant message (one per content block / stream step), each
 *  echoing the SAME message.id and the FULL message.usage — so summing every line double/triple-counts
 *  tokens and cost (observed ~3.7× on a real check-in). We dedupe by message.id, counting each message's
 *  usage once; id-less lines have nothing to dedupe on so each is counted (they are genuinely distinct). */
export function sumTranscriptTokens(transcriptPath) {
  const totals = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 };
  if (!transcriptPath) return totals;
  let text;
  try {
    text = readFileSync(transcriptPath, 'utf8');
  } catch {
    return totals;
  }
  const seen = new Set();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const msg = JSON.parse(t)?.message;
      const u = msg?.usage;
      if (!u) continue;
      if (msg.id) {
        if (seen.has(msg.id)) continue; // a repeated streaming line for an already-counted message
        seen.add(msg.id);
      }
      totals.tokensIn += u.input_tokens || 0;
      totals.tokensOut += u.output_tokens || 0;
      totals.cacheReadTokens += u.cache_read_input_tokens || 0;
      totals.cacheWriteTokens += u.cache_creation_input_tokens || 0;
      totals.costMicros += priceMessageMicros(msg.model, u);
    } catch {
      /* skip malformed lines */
    }
  }
  return totals;
}

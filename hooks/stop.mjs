#!/usr/bin/env node
// ABOUTME: Claude Code Stop hook → closes the run with best-effort token + cost totals parsed from the
// ABOUTME: transcript (cost priced per-message by model via hooks/pricing.mjs). Wired to Stop AND
// ABOUTME: SubagentStop, but a finishing subagent must NOT tear down the parent's run (see below).

import { readStdin, post, readRunId, clearRunId, clearCancelFlag, sumTranscriptTokens, AGENT_LABEL } from './_lib.mjs';

const input = await readStdin();
const cwd = input.cwd || process.cwd();

// A Task subagent shares the parent's cwd, and the run id + kill-switch flag are cwd-keyed — yet there's
// no SubagentStart opening a child run. So SubagentStop running the full Stop teardown would prematurely
// run.end the PARENT run and wipe its run/cancel files mid-session (which also silently disables the kill
// switch). Only a real session Stop closes the run. (Missing hook_event_name → treat as Stop: safe default.)
if (input.hook_event_name === 'SubagentStop') process.exit(0);

const runId = readRunId(cwd);
if (!runId) {
  clearCancelFlag(cwd); // no open run to end, but never leave a kill-switch flag for the next run
  process.exit(0);
}

const totals = sumTranscriptTokens(input.transcript_path);

await post({
  type: 'run.end',
  id: runId,
  agentLabel: AGENT_LABEL,
  status: 'completed',
  ...totals, // tokensIn/out/cacheRead/cacheWrite + costMicros — absolute, applied with a GREATEST guard server-side
});

clearRunId(cwd);
clearCancelFlag(cwd); // run is over — drop the kill-switch flag (session-start also clears it next run)
process.exit(0);

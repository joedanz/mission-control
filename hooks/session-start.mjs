#!/usr/bin/env node
// ABOUTME: Claude Code SessionStart hook → opens a Mission Control run and records its id in the
// ABOUTME: cwd-keyed file so subsequent `mc` calls (and the Stop hook) attribute to the same run.

import { randomUUID } from 'node:crypto';
import { readStdin, post, writeRunId, clearCancelFlag, AGENT_LABEL } from './_lib.mjs';

const input = await readStdin();
const cwd = input.cwd || process.cwd();
// Honor an externally-supplied run id (the auto-claim daemon pre-registers + claims a task under a run id,
// then passes MC_RUN_ID into the child `claude -p` so its telemetry + kill-switch bind to the SAME run).
// Normal interactive sessions never set it → fresh uuid, as before. run.start is idempotent on id either way.
// This mirrors cli/index.ts resolveRunId(), which already prefers MC_RUN_ID over the cwd-keyed file.
const runId = process.env.MC_RUN_ID || randomUUID();

await post({
  type: 'run.start',
  id: runId,
  agentLabel: AGENT_LABEL,
  source: 'hook',
  sessionId: input.session_id ?? null,
  workDir: cwd, // ingest auto-links to a project whose repoPath === cwd
  transcriptRef: input.transcript_path ?? null,
  title: input.source ? `session: ${input.source}` : null,
});

writeRunId(cwd, runId);
clearCancelFlag(cwd); // a fresh run starts un-cancelled, even if a prior run in this cwd was cancelled
process.exit(0);

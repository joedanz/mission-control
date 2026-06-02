#!/usr/bin/env node
// ABOUTME: Claude Code PreToolUse hook → the kill-switch ENFORCEMENT half (R9). When the operator has
// ABOUTME: cancelled this run (mc run cancel / the Stop button), halt the turn before the next tool runs.
// ABOUTME: Reads a LOCAL flag the PostToolUse heartbeat set — no network on the hot path. Fail-open:
// ABOUTME: any problem → allow the tool, because a kill switch must never wedge a legitimate run.

import { readStdin, readCancelFlag, killSwitchHalt } from './_lib.mjs';

const input = await readStdin();
const cwd = input.cwd || process.cwd();

// Only act when the flag is present. We do NOT clear it: continue:false ends this turn, and if the
// session resumes the run is still cancelled, so it should keep halting until run-end (stop.mjs clears it).
if (readCancelFlag(cwd)) {
  process.stdout.write(JSON.stringify(killSwitchHalt()));
}
process.exit(0);

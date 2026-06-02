// ABOUTME: Tests for the kill-switch ENFORCEMENT half (R9). Unit (no DB): the cwd-keyed local cancel-flag
// ABOUTME: helpers PostToolUse writes / PreToolUse reads, and the PreToolUse halt payload shape (must match
// ABOUTME: the Claude Code contract — top-level continue:false + a deny block). Integration (real Neon): a
// ABOUTME: heartbeat returns cancel_requested=true after setRunCancelRequested — the exact bit the hook caches.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { eq, inArray } from 'drizzle-orm';
import { readCancelFlag, writeCancelFlag, clearCancelFlag, killSwitchHalt } from '../hooks/_lib.mjs';
import { db } from '../lib/db/index';
import { projects, runs, events } from '../lib/db/schema';
import { createProject, recordRunStart, recordRunHeartbeat, setRunCancelRequested } from '../lib/mutations';

describe('kill-switch local flag (PostToolUse writes / PreToolUse reads)', () => {
  const cwd = `/tmp/mc-killswitch-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  afterEach(() => clearCancelFlag(cwd));

  it('round-trips: unset → write → read true → clear → read false', () => {
    expect(readCancelFlag(cwd)).toBe(false);
    writeCancelFlag(cwd);
    expect(readCancelFlag(cwd)).toBe(true);
    clearCancelFlag(cwd);
    expect(readCancelFlag(cwd)).toBe(false);
  });

  it('is keyed by cwd — a flag on one dir does not leak to another', () => {
    writeCancelFlag(cwd);
    expect(readCancelFlag(`${cwd}-other`)).toBe(false);
  });
});

describe('killSwitchHalt payload (Claude Code PreToolUse contract)', () => {
  it('halts the whole turn (continue:false) AND denies the in-flight tool with a reason', () => {
    const halt = killSwitchHalt();
    expect(halt.continue).toBe(false); // the load-bearing field: top-level continue:false ends the turn
    expect(typeof halt.stopReason).toBe('string');
    expect(halt.stopReason.length).toBeGreaterThan(0);
    expect(halt.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(halt.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(typeof halt.hookSpecificOutput.permissionDecisionReason).toBe('string');
  });
});

describe('pre-tool-use.mjs script (stdin → stdout) — the actual enforcement hook end-to-end', () => {
  const cwd = `/tmp/mc-killswitch-script-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  afterEach(() => clearCancelFlag(cwd));

  const run = () =>
    execFileSync('node', ['hooks/pre-tool-use.mjs'], {
      input: JSON.stringify({ cwd, tool_name: 'Bash' }),
      encoding: 'utf8',
    });

  it('flag set → emits the halt payload (continue:false + deny)', () => {
    writeCancelFlag(cwd);
    const parsed = JSON.parse(run());
    expect(parsed.continue).toBe(false);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('no flag → emits NOTHING — fail-open, an uncancelled run is never blocked', () => {
    expect(run().trim()).toBe(''); // the load-bearing branch: inverting the condition would wedge every tool
  });
});

describe('kill-switch read path — a heartbeat carries cancel_requested', () => {
  let projectId: string;
  let runIds: string[];

  beforeEach(async () => {
    runIds = [];
    const p = await createProject({
      name: `vitest-ks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      category: 'internal',
      status: 'prelaunch',
    });
    projectId = p.id;
  });

  afterEach(async () => {
    await db.delete(events).where(eq(events.projectId, projectId));
    if (runIds.length) await db.delete(runs).where(inArray(runs.id, runIds));
    await db.delete(projects).where(eq(projects.id, projectId)); // cascades tasks
  });

  it('heartbeat returns cancelRequested false before cancel, true after — the bit PostToolUse caches', async () => {
    const r = await recordRunStart({ agentLabel: 'vitest-ks', projectId });
    runIds.push(r.id);

    const before = await recordRunHeartbeat(r.id, {});
    expect(before?.cancelRequested).toBe(false); // a normal heartbeat → PostToolUse leaves the flag unset

    await setRunCancelRequested(r.id);

    const after = await recordRunHeartbeat(r.id, {});
    expect(after?.cancelRequested).toBe(true); // PostToolUse caches this → PreToolUse halts the next tool
  });
});

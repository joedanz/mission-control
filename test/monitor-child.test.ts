// ABOUTME: Tests for the daemon kill-switch/timeout ENFORCEMENT loop (monitorChild) — the only mechanism that
// ABOUTME: bounds a paid child process's lifetime, and previously untested (M32). Spawns a real detached
// ABOUTME: `sleep` child (its own process group, like the daemons) and asserts the wall-clock timeout fires the
// ABOUTME: SIGTERM→SIGKILL escalation against the GROUP. No DB: the per-tick `mc run heartbeat` no-ops without
// ABOUTME: creds, and the timeout path is independent of it.

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { monitorChild } from '../daemon/runner';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('monitorChild — wall-clock timeout enforcement (M32)', () => {
  it(
    'times out a wedged child and kills its process group',
    async () => {
      // Detached → its own process group, so monitorChild's negative-pgid group kill applies (matches the
      // daemon's spawn). `sleep 120` is the wedged child that never exits cooperatively.
      const child = spawn('sleep', ['120'], { detached: true, stdio: 'ignore' });
      const pid = child.pid!;
      expect(isAlive(pid)).toBe(true);

      // timeoutSec:1 → after the first 2s poll tick the elapsed wall-clock exceeds it → escalate(0) SIGTERMs
      // the group immediately, SIGKILL 5s later. graceSec is irrelevant on the timeout path.
      const res = await monitorChild(child, 'no-such-run-id', { timeoutSec: 1, graceSec: 0 }, () => {});

      expect(res.timedOut).toBe(true);
      expect(res.exitCode).toBeNull(); // killed by signal, no clean exit code
      // The whole group is gone (give the SIGTERM→SIGKILL escalation a beat to land).
      await new Promise((r) => setTimeout(r, 200));
      expect(isAlive(pid)).toBe(false);
    },
    30000,
  );

  it(
    'returns cleanly (no timeout, no kill) when the child exits before the deadline',
    async () => {
      const child = spawn('sleep', ['0.3'], { detached: true, stdio: 'ignore' });
      const res = await monitorChild(child, 'no-such-run-id', { timeoutSec: 30, graceSec: 5 }, () => {});
      expect(res.timedOut).toBe(false);
      expect(res.cancelled).toBe(false);
      expect(res.exitCode).toBe(0); // exited on its own
    },
    30000,
  );
});

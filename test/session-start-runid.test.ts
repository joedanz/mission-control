// ABOUTME: Tests the session-start.mjs MC_RUN_ID enabler (auto-claim daemon). The daemon pre-registers a run
// ABOUTME: and passes MC_RUN_ID into the child `claude -p`; the child's SessionStart hook must ADOPT that id
// ABOUTME: (so telemetry + the kill-switch bind to the same run) and otherwise mint a fresh uuid as before.
// ABOUTME: No DB / no network — INGEST_TOKEN is cleared so post() no-ops; we only assert the cwd run file.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runFile(cwd: string): string {
  return join(tmpdir(), `mc-run-${createHash('sha1').update(cwd).digest('hex').slice(0, 16)}`);
}

function runSessionStart(cwd: string, mcRunId: string): void {
  execFileSync('node', ['hooks/session-start.mjs'], {
    input: JSON.stringify({ cwd, session_id: 'vitest-session' }),
    // Clear INGEST_TOKEN so the hook's post() is a no-op (no run row created anywhere); set/clear MC_RUN_ID.
    env: { ...process.env, INGEST_TOKEN: '', MC_RUN_ID: mcRunId },
    encoding: 'utf8',
  });
}

describe('session-start.mjs honors MC_RUN_ID', () => {
  const cwd = `/tmp/mc-ss-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  afterEach(() => {
    try {
      rmSync(runFile(cwd), { force: true });
    } catch {
      /* best-effort */
    }
  });

  it('writes the externally-supplied MC_RUN_ID to the cwd-keyed run file (the daemon path)', () => {
    const RID = 'daemon-supplied-run-id-abc123';
    runSessionStart(cwd, RID);
    expect(readFileSync(runFile(cwd), 'utf8').trim()).toBe(RID);
  });

  it('mints a fresh uuid when MC_RUN_ID is unset (the normal interactive path, unchanged)', () => {
    runSessionStart(cwd, ''); // empty MC_RUN_ID → falls back to randomUUID()
    const id = readFileSync(runFile(cwd), 'utf8').trim();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id).not.toBe('daemon-supplied-run-id-abc123');
  });
});

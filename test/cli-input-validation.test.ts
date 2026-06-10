// ABOUTME: Integration tests for CLI numeric/enum input validation (audit LT2). Drives the real `tsx cli/index.ts`
// ABOUTME: via execFileSync and asserts that garbage numeric flags fail fast as VALIDATION (exit 2) through the JSON
// ABOUTME: envelope — instead of silently disabling a cap (NaN), truncating money (parseInt '1.5e6' -> 1), or
// ABOUTME: returning an empty list for a misspelled status. No DB: every checked path validates before loadDb().

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');

/** Run the CLI and return {status, env}. execFileSync throws on a non-zero exit; we capture either way. */
function runCli(args: string[]): { status: number; env: { ok: boolean; error?: { code: string; field?: string } } } {
  try {
    const out = execFileSync(tsxBin, ['cli/index.ts', ...args, '--json'], { encoding: 'utf8', timeout: 55000 });
    return { status: 0, env: JSON.parse(out) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { status: err.status ?? -1, env: JSON.parse(err.stdout || '{}') };
  }
}

describe('CLI input validation (audit LT2)', () => {
  it('workflow run --max-parallel garbage → VALIDATION exit 2 (not a silent NaN cap)', () => {
    const { status, env } = runCli(['workflow', 'run', 'no-such-wf', '--max-parallel', 'abc']);
    expect(status).toBe(2);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('VALIDATION');
  });

  it('workflow run --timeout 0 → VALIDATION exit 2 (not a silent disabled timeout)', () => {
    const { status, env } = runCli(['workflow', 'run', 'no-such-wf', '--timeout', '0']);
    expect(status).toBe(2);
    expect(env.error?.code).toBe('VALIDATION');
  });

  it('run end --cost-micros garbage → VALIDATION (not a silently-omitted $0 metric)', () => {
    const id = '00000000-0000-0000-0000-000000000000';
    const { status, env } = runCli(['run', 'end', id, 'completed', '--cost-micros', 'abc']);
    expect(status).toBe(2);
    expect(env.error?.code).toBe('VALIDATION');
    expect(env.error?.field).toBe('cost-micros');
  });

  it('run end --cost-micros 1.5e6 parses to its real value (not parseInt truncation to 1) — past validation', () => {
    const id = '00000000-0000-0000-0000-000000000000';
    const { env } = runCli(['run', 'end', id, 'completed', '--cost-micros', '1.5e6']);
    // It must NOT be rejected as bad input — it parses to 1500000 and proceeds to the DB/cred layer.
    expect(env.error?.code).not.toBe('VALIDATION');
  });

  it('task list --status typo → VALIDATION (not an empty list)', () => {
    const { status, env } = runCli(['task', 'list', 'any-slug', '--status', 'inprogress']);
    expect(status).toBe(2);
    expect(env.error?.code).toBe('VALIDATION');
    expect(env.error?.field).toBe('status');
  });
});

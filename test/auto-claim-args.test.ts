// ABOUTME: Hermetic tests for the auto-claim daemon's numeric flag parsing (audit LT7). parseArgs validates
// ABOUTME: BEFORE any DB/lock access, so spawning `tsx daemon/auto-claim.ts` with a bad flag exits 2 without a
// ABOUTME: database. Pins that a literal 0 / garbage is no longer silently swallowed by `Number(x) || default`.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');

/** Run the daemon with the given args; return the exit code (0 if it somehow succeeds). */
function exitCodeOf(args: string[]): number {
  try {
    execFileSync(tsxBin, ['daemon/auto-claim.ts', ...args], { encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

describe('auto-claim parseArgs numeric validation (audit LT7)', () => {
  it('rejects --timeout 0 (a "no timeout" guess) with exit 2 instead of silently using 900', () => {
    expect(exitCodeOf(['--project', 'anything', '--timeout', '0'])).toBe(2);
  });
  it('rejects garbage and negatives', () => {
    expect(exitCodeOf(['--project', 'anything', '--poll', 'abc'])).toBe(2);
    expect(exitCodeOf(['--project', 'anything', '--max-tasks', '-1'])).toBe(2);
    expect(exitCodeOf(['--project', 'anything', '--grace', '1.5'])).toBe(2);
  });
});

// ABOUTME: Unit tests for the daemon runner's pure helpers. parseResultMetrics turns a `claude -p
// ABOUTME: --output-format json` result into AUTHORITATIVE run metrics (claude's own total_cost_usd + usage),
// ABOUTME: which the daemon records to override the hooks' transcript ESTIMATE. No DB / no spawn.

import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseResultMetrics, spawnExecutor } from '../daemon/runner';
import { MissingSkillError } from '../daemon/render-profile';
import type { AgentProfile } from '../lib/db/schema';

describe('parseResultMetrics (pure)', () => {
  const result = {
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.2205297,
    usage: { input_tokens: 21, output_tokens: 549, cache_read_input_tokens: 87012, cache_creation_input_tokens: 167250 },
  };

  it("extracts claude's authoritative cost (→ micros) and usage from the result line", () => {
    expect(parseResultMetrics(JSON.stringify(result))).toEqual({
      costMicros: 220530, // round(0.2205297 * 1e6)
      tokensIn: 21,
      tokensOut: 549,
      cacheReadTokens: 87012,
      cacheWriteTokens: 167250,
    });
  });

  it('finds the result among other stdout lines (last result wins)', () => {
    const out = ['{"type":"system","subtype":"init"}', 'some stray log line', JSON.stringify(result)].join('\n');
    expect(parseResultMetrics(out)?.costMicros).toBe(220530);
    expect(parseResultMetrics(out)?.tokensOut).toBe(549);
  });

  it('returns null when there is no result JSON (exec/stub output, empty, or non-JSON)', () => {
    expect(parseResultMetrics('')).toBeNull();
    expect(parseResultMetrics('hello\nworld')).toBeNull();
    expect(parseResultMetrics('{"type":"assistant","message":{}}')).toBeNull(); // no total_cost_usd
  });

  it('tolerates a missing usage block (cost only)', () => {
    expect(parseResultMetrics(JSON.stringify({ type: 'result', total_cost_usd: 0.5 }))).toEqual({
      costMicros: 500000,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

describe('spawnExecutor — skill enforcement (U3)', () => {
  // The throw fires ABOVE the MC_DAEMON_EXEC branch, so the stub lets us assert enforcement without
  // launching real claude; for the no-throw cases the stub returns a harmless `exit 0` child we kill.
  let prevExec: string | undefined;
  let repo: string;

  beforeAll(() => {
    prevExec = process.env.MC_DAEMON_EXEC;
    process.env.MC_DAEMON_EXEC = 'exit 0';
  });
  afterAll(() => {
    if (prevExec === undefined) delete process.env.MC_DAEMON_EXEC;
    else process.env.MC_DAEMON_EXEC = prevExec;
  });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'mc-runner-skill-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** Minimal profile — only `skills` is read before the stub branch returns. */
  const prof = (skills: string[]): AgentProfile => ({ skills } as unknown as AgentProfile);
  const base = (profile: AgentProfile | null) => ({
    prompt: 'x',
    runId: 'r1',
    repoPath: repo,
    profile,
    effectiveModel: null,
    basePermissionMode: 'plan',
  });

  it('throws MissingSkillError when a declared skill is absent from both dirs', () => {
    expect(() => spawnExecutor(base(prof(['mc-test-absent-skill-zzz'])))).toThrow(MissingSkillError);
  });

  it('resolves a work-dir skill and does not throw', () => {
    mkdirSync(join(repo, '.claude', 'skills', 'deploy-helper'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'skills', 'deploy-helper', 'SKILL.md'), '---\nname: deploy-helper\ndescription: d\n---\n');
    const spawned = spawnExecutor(base(prof(['deploy-helper'])));
    spawned.child.kill();
    expect(spawned.child).toBeDefined();
  });

  it('does no resolution for an empty skills array (no throw)', () => {
    const spawned = spawnExecutor(base(prof([])));
    spawned.child.kill();
    expect(spawned.child).toBeDefined();
  });

  it('does no resolution for a null profile (no throw)', () => {
    const spawned = spawnExecutor(base(null));
    spawned.child.kill();
    expect(spawned.child).toBeDefined();
  });
});

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

  // A live child PID + the full {cleanup, output} contract — `expect(child).toBeDefined()` alone passed even on
  // a broken spawn (the stub object is always truthy); asserting a real pid proves a process actually launched.
  function assertReallySpawned(spawned: { child: { pid?: number; kill: () => void }; cleanup: unknown; output: unknown }) {
    expect(spawned.child.pid).toBeGreaterThan(0);
    expect(typeof spawned.cleanup).toBe('function');
    expect(typeof spawned.output).toBe('function');
    expect(typeof (spawned.output as () => string)()).toBe('string');
    spawned.child.kill();
  }

  it('resolves a work-dir skill and spawns a real child', () => {
    mkdirSync(join(repo, '.claude', 'skills', 'deploy-helper'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'skills', 'deploy-helper', 'SKILL.md'), '---\nname: deploy-helper\ndescription: d\n---\n');
    assertReallySpawned(spawnExecutor(base(prof(['deploy-helper']))));
  });

  it('does no resolution for an empty skills array (spawns a real child)', () => {
    assertReallySpawned(spawnExecutor(base(prof([]))));
  });

  it('does no resolution for a null profile (spawns a real child)', () => {
    assertReallySpawned(spawnExecutor(base(null)));
  });
});

describe('spawnExecutor — plugin skill enforcement (U4)', () => {
  // MC_CLAUDE_HOME redirects the user settings + install registry to a tmp fixture; MC_DAEMON_EXEC stubs the
  // spawn so we assert enforcement (throw / no-throw) without launching real claude.
  let prevExec: string | undefined;
  let prevHome: string | undefined;
  let home: string;
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
    home = mkdtempSync(join(tmpdir(), 'mc-runner-home-'));
    repo = mkdtempSync(join(tmpdir(), 'mc-runner-plugrepo-'));
    prevHome = process.env.MC_CLAUDE_HOME;
    process.env.MC_CLAUDE_HOME = home;
    mkdirSync(join(home, 'plugins'), { recursive: true });
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.MC_CLAUDE_HOME;
    else process.env.MC_CLAUDE_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  /** Plant `<home>/plugins/cache/<mkt>/<plugin>/1.0.0/skills/<skill>/SKILL.md`; return the installPath. */
  function plantPlugin(marketplace: string, plugin: string, skills: string[]): string {
    const installPath = join(home, 'plugins', 'cache', marketplace, plugin, '1.0.0');
    for (const skill of skills) {
      mkdirSync(join(installPath, 'skills', skill), { recursive: true });
      writeFileSync(join(installPath, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: d\n---\n`);
    }
    return installPath;
  }
  function writeUserSettings(enabled: Record<string, boolean>): void {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: enabled }));
  }
  function writeInstalled(plugins: Record<string, { installPath: string }[]>): void {
    writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
  }

  const prof = (skills: string[]): AgentProfile => ({ skills } as unknown as AgentProfile);
  const base = (profile: AgentProfile) => ({
    prompt: 'x',
    runId: 'r1',
    repoPath: repo,
    profile,
    effectiveModel: null,
    basePermissionMode: 'plan',
  });

  it('resolves an enabled + installed plugin skill and does not throw (AE1)', () => {
    const ip = plantPlugin('mkt-a', 'demo', ['do-thing']);
    writeUserSettings({ 'demo@mkt-a': true });
    writeInstalled({ 'demo@mkt-a': [{ installPath: ip }] });
    const spawned = spawnExecutor(base(prof(['demo:do-thing'])));
    spawned.child.kill();
    expect(spawned.child).toBeDefined();
  });

  it('throws MissingSkillError (plugin-disabled) when installed but not enabled (AE2)', () => {
    const ip = plantPlugin('mkt-a', 'demo', ['do-thing']);
    writeUserSettings({ 'demo@mkt-a': false });
    writeInstalled({ 'demo@mkt-a': [{ installPath: ip }] });
    expect(() => spawnExecutor(base(prof(['demo:do-thing'])))).toThrow(/plugin-disabled/);
  });

  it('throws MissingSkillError (plugin-not-installed) when not installed (AE3)', () => {
    writeUserSettings({});
    writeInstalled({});
    expect(() => spawnExecutor(base(prof(['ghost:foo'])))).toThrow(/plugin-not-installed/);
  });

  it('throws MissingSkillError (skill-not-found) when enabled+installed but no such skill dir (AE4)', () => {
    const ip = plantPlugin('mkt-a', 'demo', ['other']);
    writeUserSettings({ 'demo@mkt-a': true });
    writeInstalled({ 'demo@mkt-a': [{ installPath: ip }] });
    expect(() => spawnExecutor(base(prof(['demo:do-thing'])))).toThrow(/skill-not-found/);
  });

  it('resolves a plugin enabled only in the work-dir project settings (AE5 union)', () => {
    const ip = plantPlugin('mkt-a', 'demo', ['do-thing']);
    writeUserSettings({}); // not enabled in user settings
    writeInstalled({ 'demo@mkt-a': [{ installPath: ip }] });
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'demo@mkt-a': true } }));
    const spawned = spawnExecutor(base(prof(['demo:do-thing'])));
    spawned.child.kill();
    expect(spawned.child).toBeDefined();
  });
});

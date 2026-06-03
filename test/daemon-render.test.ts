// ABOUTME: Slice-2 pure render coverage — turns a resolved AgentProfile into a concrete spawn plan
// ABOUTME: (claude-code flags or an exec command) and resolves ${ENV} placeholders for env + MCP config.
// ABOUTME: No DB / no spawn / no fs — this is the testable core the daemon calls before it forks a child.

import { describe, it, expect } from 'vitest';
import type { AgentProfile, McpServerConfig } from '../lib/db/schema';
import {
  resolvePlaceholders,
  resolveProfileEnv,
  resolveMcpConfigJson,
  mergeMcpServers,
  planSpawn,
  chooseModel,
  MissingEnvError,
} from '../daemon/render-profile';

/** A complete AgentProfile with claude-code defaults; override only what a case exercises. */
function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'p1',
    slug: 'p1',
    name: 'P1',
    description: null,
    runtime: 'claude-code',
    model: null,
    fallbackModel: null,
    dailyBudgetMicros: null,
    provider: null,
    baseUrl: null,
    permissionMode: null,
    skills: [],
    mcpServers: null,
    allowedTools: [],
    disallowedTools: [],
    appendSystemPrompt: null,
    env: {},
    execTemplate: null,
    matchRules: null,
    priority: 0,
    isDefault: false,
    enabled: true,
    scheduleEnabled: false,
    scheduleProjectId: null,
    scheduleIntervalSec: null,
    scheduleCron: null,
    scheduleTimezone: null,
    checkInPrompt: null,
    lastCheckInAt: null,
    consecutiveFailures: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const PROMPT = 'do the thing';

describe('resolvePlaceholders (pure)', () => {
  it('substitutes every ${VAR} from the host env', () => {
    expect(resolvePlaceholders('a ${X} b ${Y}', { X: '1', Y: '2' })).toBe('a 1 b 2');
  });
  it('passes through a string with no placeholders', () => {
    expect(resolvePlaceholders('plain value', {})).toBe('plain value');
  });
  it('throws MissingEnvError naming the unset var', () => {
    try {
      resolvePlaceholders('${GITHUB_TOKEN}', {}, 'env.TOKEN');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingEnvError);
      expect((e as MissingEnvError).varName).toBe('GITHUB_TOKEN');
    }
  });
});

describe('resolveProfileEnv (pure)', () => {
  it('resolves placeholder values; leaves literals alone', () => {
    expect(resolveProfileEnv({ TOKEN: '${K}', MODE: 'fast' }, { K: 'sek' })).toEqual({ TOKEN: 'sek', MODE: 'fast' });
  });
  it('throws when a referenced var is absent', () => {
    expect(() => resolveProfileEnv({ TOKEN: '${MISSING}' }, {})).toThrow(MissingEnvError);
  });
});

describe('resolveMcpConfigJson (pure)', () => {
  it('returns null when there are no servers', () => {
    expect(resolveMcpConfigJson(null, {})).toBeNull();
    expect(resolveMcpConfigJson({}, {})).toBeNull();
  });
  it('deep-resolves header + env placeholders and wraps in { mcpServers }', () => {
    const json = resolveMcpConfigJson(
      {
        gh: { type: 'http', url: 'https://api', headers: { Authorization: 'Bearer ${GH}' } },
        fs: { type: 'stdio', command: 'mcp-fs', env: { ROOT: '${HOME}' } },
      },
      { GH: 'tok123', HOME: '/home/joe' },
    );
    const parsed = JSON.parse(json!);
    expect(parsed.mcpServers.gh.headers.Authorization).toBe('Bearer tok123');
    expect(parsed.mcpServers.fs.env.ROOT).toBe('/home/joe');
    expect(parsed.mcpServers.gh.url).toBe('https://api'); // untouched
  });
  it('throws when an MCP secret references an unset var', () => {
    expect(() =>
      resolveMcpConfigJson({ gh: { type: 'http', url: 'https://api', headers: { Authorization: 'Bearer ${GH}' } } }, {}),
    ).toThrow(MissingEnvError);
  });
});

describe('planSpawn — no profile (back-compat)', () => {
  it('renders the daemon historical claude -p plan spawn (no auto-fed servers)', () => {
    const plan = planSpawn(null, { prompt: PROMPT, basePermissionMode: 'plan', hostEnv: {} });
    expect(plan).toEqual({
      runtime: 'claude-code',
      bin: 'claude',
      args: ['-p', PROMPT, '--permission-mode', 'plan', '--output-format', 'json'],
      extraEnv: {},
    });
  });

  it('appends --mcp-config + --strict-mcp-config when servers are auto-fed (mcpConfigPath set)', () => {
    const plan = planSpawn(null, { prompt: PROMPT, basePermissionMode: 'plan', mcpConfigPath: '/tmp/mc-mcp-x.json', hostEnv: {} });
    expect(plan.args).toEqual([
      '-p', PROMPT, '--permission-mode', 'plan', '--output-format', 'json',
      '--mcp-config', '/tmp/mc-mcp-x.json', '--strict-mcp-config',
    ]);
    expect(plan.runtime).toBe('claude-code');
  });
});

describe('planSpawn — executor binary override (MC_CLAUDE_BIN)', () => {
  it('pins the claude-code bin from hostEnv.MC_CLAUDE_BIN (deployment escapes a shadowed `claude` on PATH)', () => {
    const plan = planSpawn(profile({ model: 'opus' }), {
      prompt: PROMPT,
      basePermissionMode: 'plan',
      hostEnv: { MC_CLAUDE_BIN: '/Users/me/.local/bin/claude' },
    });
    expect(plan.bin).toBe('/Users/me/.local/bin/claude');
  });
  it('also pins the no-profile back-compat spawn', () => {
    const plan = planSpawn(null, { prompt: PROMPT, basePermissionMode: 'plan', hostEnv: { MC_CLAUDE_BIN: '/abs/claude' } });
    expect(plan.bin).toBe('/abs/claude');
  });
  it('defaults to bare `claude` when the override is unset', () => {
    expect(planSpawn(null, { prompt: PROMPT, basePermissionMode: 'plan', hostEnv: {} }).bin).toBe('claude');
  });
  it('does not apply to the exec runtime (that always runs via sh -c)', () => {
    const plan = planSpawn(profile({ runtime: 'exec', execTemplate: 'run ${PROMPT}' }), {
      prompt: PROMPT,
      basePermissionMode: 'plan',
      hostEnv: { MC_CLAUDE_BIN: '/abs/claude' },
    });
    expect(plan.bin).toBe('sh');
  });
});

describe('planSpawn — claude-code', () => {
  it('maps profile fields onto real claude -p flags', () => {
    const plan = planSpawn(
      profile({
        permissionMode: 'acceptEdits',
        model: 'opus',
        appendSystemPrompt: 'You are a release engineer.',
        skills: ['deploy', 'canary'],
        allowedTools: ['Bash', 'Edit'],
        disallowedTools: ['WebFetch'],
        env: { ANTHROPIC_BASE_URL: '${GATEWAY}' },
      }),
      { prompt: PROMPT, basePermissionMode: 'plan', mcpConfigPath: '/tmp/mc.json', hostEnv: { GATEWAY: 'https://gw' } },
    );
    expect(plan.bin).toBe('claude');
    const a = plan.args;
    expect(a.slice(0, 2)).toEqual(['-p', PROMPT]);
    // profile.permissionMode wins over the daemon base
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(a[a.indexOf('--model') + 1]).toBe('opus');
    const append = a[a.indexOf('--append-system-prompt') + 1];
    expect(append).toContain('release engineer');
    expect(append).toContain('/deploy');
    expect(append).toContain('/canary');
    expect(a[a.indexOf('--allowedTools') + 1]).toBe('Bash,Edit');
    expect(a[a.indexOf('--disallowed-tools') + 1]).toBe('WebFetch');
    expect(a[a.indexOf('--mcp-config') + 1]).toBe('/tmp/mc.json');
    expect(a).toContain('--strict-mcp-config');
    expect(plan.extraEnv).toEqual({ ANTHROPIC_BASE_URL: 'https://gw' });
  });

  it('falls back to the daemon base permission mode when the profile omits one', () => {
    const plan = planSpawn(profile(), { prompt: PROMPT, basePermissionMode: 'plan', hostEnv: {} });
    expect(plan.args[plan.args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(plan.args).not.toContain('--mcp-config'); // none configured
    expect(plan.args).not.toContain('--model');
  });

  it('merges extraAllowedTools into --allowedTools (the daemon grants self-serve mc access for check-ins)', () => {
    // a profile with NO allowedTools still gets the grant — the whole point is to not require the operator
    // to remember `--allowed-tools Bash(mc:*)` for a check-in to be able to claim work.
    const bare = planSpawn(profile(), { prompt: PROMPT, basePermissionMode: 'plan', hostEnv: {}, extraAllowedTools: ['Bash(mc:*)'] });
    expect(bare.args[bare.args.indexOf('--allowedTools') + 1]).toBe('Bash(mc:*)');
    // appended after the profile's own tools, in order
    const withTools = planSpawn(profile({ allowedTools: ['Edit'] }), { prompt: PROMPT, basePermissionMode: 'plan', hostEnv: {}, extraAllowedTools: ['Bash(mc:*)'] });
    expect(withTools.args[withTools.args.indexOf('--allowedTools') + 1]).toBe('Edit,Bash(mc:*)');
  });

  it('dedupes extraAllowedTools the profile already lists', () => {
    const plan = planSpawn(profile({ allowedTools: ['Bash(mc:*)', 'Edit'] }), { prompt: PROMPT, basePermissionMode: 'plan', hostEnv: {}, extraAllowedTools: ['Bash(mc:*)'] });
    expect(plan.args[plan.args.indexOf('--allowedTools') + 1]).toBe('Bash(mc:*),Edit');
  });

  it('omits --allowedTools when neither the profile nor extraAllowedTools provide any (back-compat)', () => {
    const plan = planSpawn(profile(), { prompt: PROMPT, basePermissionMode: 'plan', hostEnv: {} });
    expect(plan.args).not.toContain('--allowedTools');
  });
});

describe('chooseModel — budget downgrade (pure)', () => {
  it('keeps the primary model when there is no budget cap', () => {
    expect(chooseModel(profile({ model: 'opus', fallbackModel: 'haiku' }), 999_999_999)).toEqual({ model: 'opus', downgraded: false });
  });
  it('keeps the primary model while under the cap', () => {
    const p = profile({ model: 'opus', fallbackModel: 'haiku', dailyBudgetMicros: 5_000_000 });
    expect(chooseModel(p, 4_999_999)).toEqual({ model: 'opus', downgraded: false });
  });
  it('downgrades to the fallback once spend reaches the cap', () => {
    const p = profile({ model: 'opus', fallbackModel: 'haiku', dailyBudgetMicros: 5_000_000 });
    expect(chooseModel(p, 5_000_000)).toEqual({ model: 'haiku', downgraded: true });
  });
  it('does not downgrade when the cap is set but no fallback exists (nothing to switch to)', () => {
    const p = profile({ model: 'opus', dailyBudgetMicros: 5_000_000 });
    expect(chooseModel(p, 9_000_000)).toEqual({ model: 'opus', downgraded: false });
  });
  it('returns model:null for a null profile', () => {
    expect(chooseModel(null, 0)).toEqual({ model: null, downgraded: false });
  });
});

describe('planSpawn — fallback model', () => {
  it('renders --fallback-model (resilience) alongside --model for claude-code', () => {
    const plan = planSpawn(profile({ model: 'opus', fallbackModel: 'claude-sonnet-4-6' }), {
      prompt: PROMPT,
      basePermissionMode: 'plan',
      hostEnv: {},
    });
    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('opus');
    expect(plan.args[plan.args.indexOf('--fallback-model') + 1]).toBe('claude-sonnet-4-6');
  });

  it('uses effectiveModel (the daemon-chosen, possibly downgraded model) over profile.model', () => {
    const plan = planSpawn(profile({ model: 'opus', fallbackModel: 'haiku' }), {
      prompt: PROMPT,
      basePermissionMode: 'plan',
      hostEnv: {},
      effectiveModel: 'haiku', // budget exceeded → daemon already downgraded
    });
    expect(plan.args[plan.args.indexOf('--model') + 1]).toBe('haiku');
  });

  it('exposes ${FALLBACK_MODEL} to exec templates', () => {
    const plan = planSpawn(
      profile({ runtime: 'exec', model: 'gpt-4o', fallbackModel: 'gpt-4o-mini', execTemplate: 'run --model ${MODEL} --fb ${FALLBACK_MODEL}' }),
      { prompt: PROMPT, basePermissionMode: 'plan', hostEnv: {} },
    );
    expect(plan.args[1]).toContain("--model 'gpt-4o'");
    expect(plan.args[1]).toContain("--fb 'gpt-4o-mini'");
  });
});

describe('planSpawn — exec (non-Claude runtime)', () => {
  it('substitutes shell-quoted tokens into the execTemplate and runs via sh -c', () => {
    const danger = "it's; $(whoami)";
    const plan = planSpawn(
      profile({ runtime: 'exec', model: 'gpt-4o', execTemplate: 'runner --model ${MODEL} --mcp ${MCP_CONFIG} -- ${PROMPT}' }),
      { prompt: danger, basePermissionMode: 'plan', mcpConfigPath: '/tmp/m.json', hostEnv: {} },
    );
    expect(plan.bin).toBe('sh');
    expect(plan.args[0]).toBe('-c');
    const cmd = plan.args[1];
    const expectedPrompt = `'${danger.replace(/'/g, "'\\''")}'`; // POSIX single-quote escaping
    expect(cmd).toContain(expectedPrompt); // the injection-y prompt is inert inside single quotes
    expect(cmd).toContain("--model 'gpt-4o'");
    expect(cmd).toContain("--mcp '/tmp/m.json'");
  });

  it('throws if an exec profile somehow has no execTemplate', () => {
    expect(() =>
      planSpawn(profile({ runtime: 'exec', execTemplate: null }), { prompt: PROMPT, basePermissionMode: 'plan', hostEnv: {} }),
    ).toThrow();
  });
});

describe('mergeMcpServers (pure)', () => {
  const a: McpServerConfig = { type: 'http', url: 'https://a' };
  const b: McpServerConfig = { type: 'http', url: 'https://b' };

  it('returns null when both are empty', () => {
    expect(mergeMcpServers(null, null)).toBeNull();
    expect(mergeMcpServers({}, {})).toBeNull();
  });

  it('passes a base (profile) map through when there is no extra', () => {
    expect(mergeMcpServers({ gh: a }, null)).toEqual({ gh: a });
  });

  it('unions disjoint keys', () => {
    expect(mergeMcpServers({ gh: a }, { 'composio-linear': b })).toEqual({ gh: a, 'composio-linear': b });
  });

  it('profile (base) wins a key collision', () => {
    expect(mergeMcpServers({ 'composio-linear': a }, { 'composio-linear': b })).toEqual({ 'composio-linear': a });
  });
});

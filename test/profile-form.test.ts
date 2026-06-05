// ABOUTME: Slice-3 pure form-transform coverage — the UI-state ⇄ ProfileInput normalization that backs the
// ABOUTME: rich Profiles editor (chips, key/value rows, MCP-server cards, match-rule pickers). No DOM / no DB:
// ABOUTME: the gnarly "what the form holds" → "what the mutation wants" mapping is tested in isolation.

import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '../lib/db/schema';
import {
  emptyFormState,
  formStateFromProfile,
  formStateToInput,
  type ProfileFormState,
} from '../lib/profile-form';

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'p1', slug: 'p1', name: 'P1', description: null,
    runtime: 'claude-code', model: null, fallbackModel: null, dailyBudgetMicros: null, provider: null, baseUrl: null,
    permissionMode: null, skills: [], mcpServers: null,
    allowedTools: [], disallowedTools: [], appendSystemPrompt: null,
    env: {}, execTemplate: null, matchRules: null, priority: 0,
    isDefault: false, enabled: true,
    scheduleEnabled: false, scheduleProjectId: null, scheduleIntervalSec: null, scheduleCron: null,
    scheduleTimezone: null, checkInPrompt: null, lastCheckInAt: null, consecutiveFailures: 0,
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

describe('emptyFormState', () => {
  it('defaults a new profile to claude-code / enabled / priority 0', () => {
    const s = emptyFormState();
    expect(s.runtime).toBe('claude-code');
    expect(s.enabled).toBe(true);
    expect(s.isDefault).toBe(false);
    expect(s.priority).toBe('0');
    expect(s.skills).toEqual([]);
    expect(s.mcpServers).toEqual([]);
  });
});

describe('formStateToInput — scalars + chips', () => {
  it('trims scalars and maps empty strings to null', () => {
    const s: ProfileFormState = { ...emptyFormState(), slug: ' releaser ', name: ' Releaser ', model: '  ', permissionMode: '' };
    const input = formStateToInput(s);
    expect(input.slug).toBe('releaser');
    expect(input.name).toBe('Releaser');
    expect(input.model).toBeNull();
    expect(input.permissionMode).toBeNull();
  });

  it('keeps non-empty scalars including ${ENV}-bearing ones', () => {
    const s: ProfileFormState = { ...emptyFormState(), model: 'opus', permissionMode: 'acceptEdits', baseUrl: 'https://gw' };
    const input = formStateToInput(s);
    expect(input.model).toBe('opus');
    expect(input.permissionMode).toBe('acceptEdits');
    expect(input.baseUrl).toBe('https://gw');
  });

  it('filters blank chips from skills / tool lists', () => {
    const s: ProfileFormState = { ...emptyFormState(), skills: ['deploy', '', '  ', 'canary'], allowedTools: ['Bash', 'Edit'] };
    const input = formStateToInput(s);
    expect(input.skills).toEqual(['deploy', 'canary']);
    expect(input.allowedTools).toEqual(['Bash', 'Edit']);
  });
});

describe('formStateToInput — env key/value rows', () => {
  it('builds a Record, skipping rows with a blank key, preserving placeholder values', () => {
    const s: ProfileFormState = {
      ...emptyFormState(),
      env: [
        { key: 'ANTHROPIC_BASE_URL', value: '${GW}' },
        { key: '  ', value: 'ignored' },
        { key: 'MODE', value: 'fast' },
      ],
    };
    expect(formStateToInput(s).env).toEqual({ ANTHROPIC_BASE_URL: '${GW}', MODE: 'fast' });
  });
});

describe('formStateToInput — MCP server cards', () => {
  it('maps cards to the canonical inner map, omitting empty sub-objects and unnamed cards', () => {
    const s: ProfileFormState = {
      ...emptyFormState(),
      mcpServers: [
        { name: 'gh', type: 'http', command: '', args: '', url: 'https://api', env: [], headers: [{ key: 'Authorization', value: 'Bearer ${GH}' }] },
        { name: 'fs', type: 'stdio', command: 'mcp-fs', args: '--root /, --verbose', url: '', env: [{ key: 'ROOT', value: '${HOME}' }], headers: [] },
        { name: '', type: 'http', command: '', args: '', url: 'https://nope', env: [], headers: [] },
      ],
    };
    const mcp = formStateToInput(s).mcpServers!;
    expect(Object.keys(mcp)).toEqual(['gh', 'fs']); // unnamed card dropped
    expect(mcp.gh).toEqual({ type: 'http', url: 'https://api', headers: { Authorization: 'Bearer ${GH}' } });
    expect(mcp.fs).toEqual({ type: 'stdio', command: 'mcp-fs', args: ['--root /', '--verbose'], env: { ROOT: '${HOME}' } });
    expect(mcp.gh.env).toBeUndefined(); // empty sub-object omitted
  });

  it('returns null when there are no named servers', () => {
    expect(formStateToInput(emptyFormState()).mcpServers).toBeNull();
  });
});

describe('formStateToInput — match rules', () => {
  it('assembles only the non-empty dimensions', () => {
    const s: ProfileFormState = {
      ...emptyFormState(),
      matchProjectSlugs: ['acme'],
      matchProjectCategories: [],
      matchLabelPattern: '^fix:',
    };
    expect(formStateToInput(s).matchRules).toEqual({ projectSlugs: ['acme'], labelPattern: '^fix:' });
  });

  it('returns null when no dimension is set (default-only profile)', () => {
    expect(formStateToInput(emptyFormState()).matchRules).toBeNull();
  });
});

describe('formStateToInput — priority + flags', () => {
  it('parses priority and preserves enabled/isDefault', () => {
    const s: ProfileFormState = { ...emptyFormState(), priority: '7', enabled: false, isDefault: true };
    const input = formStateToInput(s);
    expect(input.priority).toBe(7);
    expect(input.enabled).toBe(false);
    expect(input.isDefault).toBe(true);
  });
  it('coerces a non-numeric priority to 0', () => {
    expect(formStateToInput({ ...emptyFormState(), priority: 'abc' }).priority).toBe(0);
  });
});

describe('formStateToInput / fromProfile — cost-aware fields (USD ⇄ micros)', () => {
  it('converts the daily-budget dollars field to micro-dollars', () => {
    const s: ProfileFormState = { ...emptyFormState(), fallbackModel: 'haiku', dailyBudgetUsd: '5' };
    const input = formStateToInput(s);
    expect(input.fallbackModel).toBe('haiku');
    expect(input.dailyBudgetMicros).toBe(5_000_000);
  });
  it('maps a blank or invalid budget to null', () => {
    expect(formStateToInput({ ...emptyFormState(), dailyBudgetUsd: '' }).dailyBudgetMicros).toBeNull();
    expect(formStateToInput({ ...emptyFormState(), dailyBudgetUsd: 'abc' }).dailyBudgetMicros).toBeNull();
    expect(formStateToInput({ ...emptyFormState(), dailyBudgetUsd: '-2' }).dailyBudgetMicros).toBeNull();
  });
  it('hydrates the dollars field back from stored micros', () => {
    const s = formStateFromProfile(profile({ fallbackModel: 'haiku', dailyBudgetMicros: 12_500_000 }));
    expect(s.fallbackModel).toBe('haiku');
    expect(s.dailyBudgetUsd).toBe('12.5');
  });
});

describe('formStateToInput / fromProfile — scheduled check-ins', () => {
  it('emptyFormState defaults the schedule off (no trigger, interval mode)', () => {
    const s = emptyFormState();
    expect(s.scheduleEnabled).toBe(false);
    expect(s.scheduleProjectId).toBe('');
    expect(s.scheduleMode).toBe('interval');
    expect(s.scheduleIntervalSec).toBe('');
    expect(s.scheduleCron).toBe('');
    expect(s.scheduleTimezone).toBe('');
    expect(s.checkInPrompt).toBe('');
  });

  it('round-trips scheduleTimezone (blank ⇄ null)', () => {
    expect(formStateToInput({ ...emptyFormState(), scheduleMode: 'cron', scheduleCron: '0 9 * * *', scheduleTimezone: 'America/New_York' }).scheduleTimezone).toBe('America/New_York');
    expect(formStateToInput({ ...emptyFormState(), scheduleTimezone: '  ' }).scheduleTimezone).toBeNull();
    expect(formStateFromProfile(profile({ scheduleCron: '0 9 * * *', scheduleTimezone: 'UTC' })).scheduleTimezone).toBe('UTC');
    expect(formStateFromProfile(profile({ scheduleTimezone: null })).scheduleTimezone).toBe('');
  });

  it('interval mode emits scheduleIntervalSec and nulls cron', () => {
    const s: ProfileFormState = {
      ...emptyFormState(),
      scheduleEnabled: true,
      scheduleProjectId: 'proj-id-1',
      scheduleMode: 'interval',
      scheduleIntervalSec: '1800',
      scheduleCron: '0 9 * * *', // stale value from the other mode — must be dropped
      checkInPrompt: 'Triage queued work.',
    };
    const input = formStateToInput(s);
    expect(input.scheduleEnabled).toBe(true);
    expect(input.scheduleProjectId).toBe('proj-id-1');
    expect(input.scheduleIntervalSec).toBe(1800);
    expect(input.scheduleCron).toBeNull();
    expect(input.checkInPrompt).toBe('Triage queued work.');
  });

  it('cron mode emits scheduleCron and nulls interval', () => {
    const s: ProfileFormState = {
      ...emptyFormState(),
      scheduleEnabled: true,
      scheduleProjectId: 'proj-id-2',
      scheduleMode: 'cron',
      scheduleIntervalSec: '1800', // stale value from the other mode — must be dropped
      scheduleCron: '0 9 * * 1-5',
    };
    const input = formStateToInput(s);
    expect(input.scheduleCron).toBe('0 9 * * 1-5');
    expect(input.scheduleIntervalSec).toBeNull();
  });

  it('maps a blank project / interval / prompt to null', () => {
    const s: ProfileFormState = { ...emptyFormState(), scheduleEnabled: true, scheduleMode: 'interval', scheduleIntervalSec: '  ', checkInPrompt: '' };
    const input = formStateToInput(s);
    expect(input.scheduleProjectId).toBeNull();
    expect(input.scheduleIntervalSec).toBeNull();
    expect(input.checkInPrompt).toBeNull();
  });

  it('hydrates interval mode from a stored profile', () => {
    const s = formStateFromProfile(profile({ scheduleEnabled: true, scheduleProjectId: 'pid', scheduleIntervalSec: 900, checkInPrompt: 'Do rounds.' }));
    expect(s.scheduleEnabled).toBe(true);
    expect(s.scheduleProjectId).toBe('pid');
    expect(s.scheduleMode).toBe('interval');
    expect(s.scheduleIntervalSec).toBe('900');
    expect(s.scheduleCron).toBe('');
    expect(s.checkInPrompt).toBe('Do rounds.');
  });

  it('derives cron mode when the stored profile has a cron expression', () => {
    const s = formStateFromProfile(profile({ scheduleEnabled: true, scheduleProjectId: 'pid', scheduleCron: '*/30 * * * *' }));
    expect(s.scheduleMode).toBe('cron');
    expect(s.scheduleCron).toBe('*/30 * * * *');
    expect(s.scheduleIntervalSec).toBe('');
  });
});

describe('formStateFromProfile — round-trips a stored profile', () => {
  it('hydrates chips / env rows / mcp cards / match pickers from the row', () => {
    const p = profile({
      slug: 'releaser', name: 'Releaser', runtime: 'exec', model: 'gpt-4o', execTemplate: 'run ${PROMPT}',
      skills: ['deploy'], allowedTools: ['Bash'], env: { TOKEN: '${T}' },
      mcpServers: { gh: { type: 'http', url: 'https://api', headers: { Authorization: 'Bearer ${GH}' } } },
      matchRules: { projectSlugs: ['acme'], labelPattern: '^fix:' }, priority: 5, enabled: false,
    });
    const s = formStateFromProfile(p);
    expect(s.runtime).toBe('exec');
    expect(s.execTemplate).toBe('run ${PROMPT}');
    expect(s.skills).toEqual(['deploy']);
    expect(s.env).toEqual([{ key: 'TOKEN', value: '${T}' }]);
    expect(s.mcpServers).toHaveLength(1);
    expect(s.mcpServers[0]).toMatchObject({ name: 'gh', type: 'http', url: 'https://api', headers: [{ key: 'Authorization', value: 'Bearer ${GH}' }] });
    expect(s.matchProjectSlugs).toEqual(['acme']);
    expect(s.matchLabelPattern).toBe('^fix:');
    expect(s.priority).toBe('5');
    expect(s.enabled).toBe(false);

    // round-trip: from → to yields the same core fields
    const back = formStateToInput(s);
    expect(back.mcpServers).toEqual(p.mcpServers);
    expect(back.matchRules).toEqual(p.matchRules);
    expect(back.env).toEqual(p.env);
    expect(back.skills).toEqual(p.skills);
  });
});

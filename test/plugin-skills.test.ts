// ABOUTME: Unit coverage for the plugin-source resolver (lib/plugin-skills.ts) — readEnabledPlugins (union +
// ABOUTME: key validation), readInstalledPlugins (installPath bounds-check), pluginSkillStatus (marketplace
// ABOUTME: intersection + the three failure reasons), and scanPluginSkills (catalog). Plants real
// ABOUTME: SKILL.md files + settings/install JSON under a tmp MC_CLAUDE_HOME; no DB, no spawn, no real ~/.claude.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type EnabledPlugins,
  type InstalledPlugins,
  installedPluginsPath,
  loadPluginContext,
  pluginSkillStatus,
  projectSettingsPath,
  readEnabledPlugins,
  readInstalledPlugins,
  scanPluginSkills,
  userSettingsPath,
} from '../lib/plugin-skills';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-plugin-skills-'));
  prevHome = process.env.MC_CLAUDE_HOME;
  process.env.MC_CLAUDE_HOME = home;
  mkdirSync(join(home, 'plugins'), { recursive: true });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.MC_CLAUDE_HOME;
  else process.env.MC_CLAUDE_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

/** Plant `<installPath>/skills/<skill>/SKILL.md` for each skill; return the installPath (under the plugins root). */
function plantPlugin(marketplace: string, plugin: string, version: string, skills: string[]): string {
  const installPath = join(home, 'plugins', 'cache', marketplace, plugin, version);
  for (const skill of skills) {
    mkdirSync(join(installPath, 'skills', skill), { recursive: true });
    writeFileSync(join(installPath, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: desc for ${plugin}:${skill}\n---\nbody\n`);
  }
  return installPath;
}

function writeSettings(path: string, enabled: Record<string, boolean>): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ enabledPlugins: enabled }));
}

function writeInstalled(plugins: Record<string, { installPath: string }[]>): void {
  writeFileSync(installedPluginsPath(), JSON.stringify({ version: 2, plugins }));
}

/** Build a context directly (for predicate/catalog tests) without going through the file readers. */
function ctx(enabled: Record<string, string[]>, installed: Record<string, { marketplace: string; installPath: string }[]>) {
  const e: EnabledPlugins = new Map(Object.entries(enabled).map(([k, v]) => [k, new Set(v)]));
  const i: InstalledPlugins = new Map(Object.entries(installed));
  return { enabled: e, installed: i };
}

describe('readEnabledPlugins', () => {
  it('unions true entries across user + project settings, ignores false, validates key segments', () => {
    writeSettings(userSettingsPath(), {
      'compound-engineering@compound-engineering-plugin': true,
      'superpowers@claude-plugins-official': false,
      '../evil@mkt': true, // crafted plugin segment → skipped
      'a@b@c': true, // multiple @ → skipped
      '@mkt': true, // empty plugin segment → skipped
    });
    const repo = mkdtempSync(join(tmpdir(), 'mc-proj-'));
    writeSettings(projectSettingsPath(repo), { 'superpowers@claude-plugins-official': true });

    const enabled = readEnabledPlugins([userSettingsPath(), projectSettingsPath(repo)]);
    expect([...enabled.keys()].sort()).toEqual(['compound-engineering', 'superpowers']);
    expect(enabled.get('compound-engineering')).toEqual(new Set(['compound-engineering-plugin']));
    expect(enabled.get('superpowers')).toEqual(new Set(['claude-plugins-official']));
    rmSync(repo, { recursive: true, force: true });
  });

  it('tolerates a missing file and a malformed-JSON file (returns what it can)', () => {
    writeFileSync(userSettingsPath(), '{ not valid json');
    const enabled = readEnabledPlugins([userSettingsPath(), join(home, 'does-not-exist.json')]);
    expect(enabled.size).toBe(0);
  });
});

describe('readInstalledPlugins', () => {
  it('maps plugin name to install entries from a well-formed registry', () => {
    const ip = plantPlugin('compound-engineering-plugin', 'compound-engineering', '3.10.0', ['ce-work']);
    writeInstalled({ 'compound-engineering@compound-engineering-plugin': [{ installPath: ip }] });
    const installed = readInstalledPlugins(installedPluginsPath());
    expect(installed.get('compound-engineering')).toEqual([{ marketplace: 'compound-engineering-plugin', installPath: ip }]);
  });

  it('rejects an entry whose installPath is non-absolute or escapes the plugins root', () => {
    writeInstalled({
      'evil@mkt': [{ installPath: '/etc' }, { installPath: '../../x' }, { installPath: join(home, 'plugins', '..', 'escape') }],
    });
    const installed = readInstalledPlugins(installedPluginsPath());
    expect(installed.has('evil')).toBe(false);
  });

  it('tolerates a missing/malformed file', () => {
    expect(readInstalledPlugins(join(home, 'nope.json')).size).toBe(0);
  });
});

describe('pluginSkillStatus', () => {
  it('resolves an enabled + installed plugin whose skill dir exists, recording the marketplace (AE1)', () => {
    const ip = plantPlugin('mkt-a', 'demo', '1.0.0', ['do-thing']);
    const c = ctx({ demo: ['mkt-a'] }, { demo: [{ marketplace: 'mkt-a', installPath: ip }] });
    expect(pluginSkillStatus('demo', 'do-thing', c)).toEqual({ resolved: true, marketplace: 'mkt-a' });
  });

  it('reports plugin-disabled when installed but not enabled (AE2)', () => {
    const ip = plantPlugin('mkt-a', 'demo', '1.0.0', ['do-thing']);
    const c = ctx({}, { demo: [{ marketplace: 'mkt-a', installPath: ip }] });
    expect(pluginSkillStatus('demo', 'do-thing', c)).toEqual({ resolved: false, reason: 'plugin-disabled' });
  });

  it('reports plugin-not-installed when not installed at all (AE3)', () => {
    const c = ctx({}, {});
    expect(pluginSkillStatus('missing', 'foo', c)).toEqual({ resolved: false, reason: 'plugin-not-installed' });
  });

  it('reports skill-not-found when enabled + installed but the skill dir is absent (AE4)', () => {
    const ip = plantPlugin('mkt-a', 'demo', '1.0.0', ['other-skill']);
    const c = ctx({ demo: ['mkt-a'] }, { demo: [{ marketplace: 'mkt-a', installPath: ip }] });
    expect(pluginSkillStatus('demo', 'do-thing', c)).toEqual({ resolved: false, reason: 'skill-not-found' });
  });

  it('resolves via a second marketplace when only it carries the skill (R4)', () => {
    const ipA = plantPlugin('mkt-a', 'demo', '1.0.0', ['unrelated']);
    const ipB = plantPlugin('mkt-b', 'demo', '1.0.0', ['do-thing']);
    const c = ctx({ demo: ['mkt-a', 'mkt-b'] }, {
      demo: [{ marketplace: 'mkt-a', installPath: ipA }, { marketplace: 'mkt-b', installPath: ipB }],
    });
    expect(pluginSkillStatus('demo', 'do-thing', c)).toEqual({ resolved: true, marketplace: 'mkt-b' });
  });

  it('does NOT resolve a marketplace divergence: enabled@A but installed only@B (KTD6)', () => {
    const ipB = plantPlugin('mkt-b', 'demo', '1.0.0', ['do-thing']);
    const c = ctx({ demo: ['mkt-a'] }, { demo: [{ marketplace: 'mkt-b', installPath: ipB }] });
    expect(pluginSkillStatus('demo', 'do-thing', c)).toEqual({ resolved: false, reason: 'plugin-not-installed' });
  });
});

describe('scanPluginSkills', () => {
  it('lists each enabled+installed plugin skill with source/plugin/marketplace/description; skips disabled; dedupes (AE6)', () => {
    const ipDemo = plantPlugin('mkt-a', 'demo', '1.0.0', ['alpha', 'beta']);
    const ipDup = plantPlugin('mkt-b', 'demo', '1.0.0', ['alpha']); // same name from a second marketplace → deduped
    const ipOff = plantPlugin('mkt-c', 'disabled-plug', '1.0.0', ['gamma']);
    const c = ctx(
      { demo: ['mkt-a', 'mkt-b'] }, // disabled-plug is NOT enabled
      {
        demo: [{ marketplace: 'mkt-a', installPath: ipDemo }, { marketplace: 'mkt-b', installPath: ipDup }],
        'disabled-plug': [{ marketplace: 'mkt-c', installPath: ipOff }],
      },
    );
    const items = scanPluginSkills(c);
    const names = items.map((s) => s.name).sort();
    expect(names).toEqual(['demo:alpha', 'demo:beta']);
    const alpha = items.find((s) => s.name === 'demo:alpha')!;
    expect(alpha).toMatchObject({ source: 'plugin', plugin: 'demo', marketplace: 'mkt-a', description: 'desc for demo:alpha' });
    expect(items.some((s) => s.plugin === 'disabled-plug')).toBe(false); // disabled → excluded
  });
});

describe('loadPluginContext (end-to-end via MC_CLAUDE_HOME)', () => {
  it('reads user settings + the install registry and resolves a planted plugin skill', () => {
    const ip = plantPlugin('compound-engineering-plugin', 'compound-engineering', '3.10.0', ['ce-work']);
    writeSettings(userSettingsPath(), { 'compound-engineering@compound-engineering-plugin': true });
    writeInstalled({ 'compound-engineering@compound-engineering-plugin': [{ installPath: ip }] });

    const c = loadPluginContext();
    expect(pluginSkillStatus('compound-engineering', 'ce-work', c)).toEqual({
      resolved: true,
      marketplace: 'compound-engineering-plugin',
    });
    expect(scanPluginSkills(c).map((s) => s.name)).toEqual(['compound-engineering:ce-work']);
  });
});

// ABOUTME: Integration test for `mc skill list` plugin enumeration (U6). Plants an enabled+installed plugin
// ABOUTME: under a tmp MC_CLAUDE_HOME and asserts `mc skill list --json` includes the plugin skill tagged
// ABOUTME: source=plugin with its plugin + marketplace — and that what the catalog lists equals what plugin
// ABOUTME: resolution would resolve (R7/R8). No DB (no --project), no spawn.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('mc skill list — plugin enumeration (U6)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mc-skill-list-home-'));
    const installPath = join(home, 'plugins', 'cache', 'compound-engineering-plugin', 'compound-engineering', '3.10.0');
    for (const skill of ['ce-work', 'ce-plan']) {
      mkdirSync(join(installPath, 'skills', skill), { recursive: true });
      writeFileSync(join(installPath, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: ${skill} desc\n---\n`);
    }
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'compound-engineering@compound-engineering-plugin': true } }));
    writeFileSync(
      join(home, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'compound-engineering@compound-engineering-plugin': [{ installPath }] } }),
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('lists enabled plugin skills with source=plugin, plugin, and marketplace', () => {
    const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const out = execFileSync(tsxBin, ['cli/index.ts', 'skill', 'list', '--json'], {
      env: { ...process.env, MC_CLAUDE_HOME: home },
      encoding: 'utf8',
      timeout: 55000,
    });
    const env = JSON.parse(out);
    expect(env.ok).toBe(true);

    const pluginItems: { name: string; source: string; plugin?: string; marketplace?: string }[] = env.data.items.filter(
      (s: { source: string }) => s.source === 'plugin',
    );
    const work = pluginItems.find((s) => s.name === 'compound-engineering:ce-work');
    expect(work).toMatchObject({
      name: 'compound-engineering:ce-work',
      source: 'plugin',
      plugin: 'compound-engineering',
      marketplace: 'compound-engineering-plugin',
    });
    // Both planted plugin skills appear (the catalog == the resolvable set).
    expect(pluginItems.map((s) => s.name).sort()).toEqual(['compound-engineering:ce-plan', 'compound-engineering:ce-work']);
  }, 60000);
});

// ABOUTME: Integration test for `mc profile resolve`'s skill-resolution report (U6). Creates a real project
// ABOUTME: + matching profile that declares a work-dir skill, an absent filesystem skill, a resolvable PLUGIN
// ABOUTME: skill, and an enabled-but-missing plugin skill — then invokes the CLI and asserts data.skills marks
// ABOUTME: each present/source/marketplace/reason correctly and skillsResolved reflects the misses. Real Neon
// ABOUTME: DB (DATABASE_URL fallback opt-in); plugin world planted under a tmp MC_CLAUDE_HOME.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, agentProfiles } from '../lib/db/schema';
import { createProject, createProfile } from '../lib/mutations';

describe('mc profile resolve — skill report (U6)', () => {
  let projectId: string;
  let slug: string;
  let repo: string;
  let home: string;
  const profileIds: string[] = [];
  const absentSkill = `mc-absent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'mc-resolve-skill-'));
    mkdirSync(join(repo, '.claude', 'skills', 'wd-skill'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'skills', 'wd-skill', 'SKILL.md'), '---\nname: wd-skill\ndescription: work-dir skill\n---\n');

    // A tmp Claude home with one enabled+installed plugin (demo:do-thing); demo:ghost has no skill dir.
    home = mkdtempSync(join(tmpdir(), 'mc-resolve-home-'));
    const installPath = join(home, 'plugins', 'cache', 'mkt-a', 'demo', '1.0.0');
    mkdirSync(join(installPath, 'skills', 'do-thing'), { recursive: true });
    writeFileSync(join(installPath, 'skills', 'do-thing', 'SKILL.md'), '---\nname: do-thing\ndescription: d\n---\n');
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'demo@mkt-a': true } }));
    writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'demo@mkt-a': [{ installPath }] } }));

    const p = await createProject({
      name: `vitest-resolve-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      category: 'internal',
      status: 'prelaunch',
      repoPath: repo,
    });
    projectId = p.id;
    slug = p.slug;
  });

  afterEach(async () => {
    while (profileIds.length) await db.delete(agentProfiles).where(eq(agentProfiles.id, profileIds.pop()!));
    await db.delete(projects).where(eq(projects.id, projectId));
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('reports source/marketplace/reason per declared filesystem + plugin skill', async () => {
    const prof = await createProfile({
      slug: `vt-resolve-prof-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: 'resolve skill report profile',
      matchRules: { projectSlugs: [slug] },
      priority: 5,
      skills: ['wd-skill', absentSkill, 'demo:do-thing', 'demo:ghost'],
    });
    profileIds.push(prof.id);

    const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const out = execFileSync(tsxBin, ['cli/index.ts', 'profile', 'resolve', '--project', slug, '--json'], {
      env: { ...process.env, MC_ALLOW_DATABASE_URL_FALLBACK: '1', MC_CLAUDE_HOME: home },
      encoding: 'utf8',
      timeout: 55000,
    });
    const env = JSON.parse(out);
    expect(env.ok).toBe(true);
    expect(env.data.profile?.slug).toBe(prof.slug);

    const skills: { name: string; source: string | null; marketplace: string | null; present: boolean; reason: string | null }[] =
      env.data.skills;
    const by = (n: string) => skills.find((s) => s.name === n);
    expect(by('wd-skill')).toEqual({ name: 'wd-skill', source: 'project', marketplace: null, present: true, reason: null });
    expect(by(absentSkill)).toEqual({ name: absentSkill, source: null, marketplace: null, present: false, reason: 'not-found' });
    expect(by('demo:do-thing')).toEqual({ name: 'demo:do-thing', source: 'plugin', marketplace: 'mkt-a', present: true, reason: null });
    expect(by('demo:ghost')).toEqual({ name: 'demo:ghost', source: null, marketplace: null, present: false, reason: 'skill-not-found' });
    expect(env.data.skillsResolved).toBe(false);
  }, 60000);
});

// ABOUTME: Integration test for `mc profile resolve`'s skill-resolution report (U6). Creates a real project
// ABOUTME: + matching profile that declares one work-dir skill (planted on disk) and one absent skill, then
// ABOUTME: invokes the CLI and asserts data.skills marks each present/source correctly and skillsResolved
// ABOUTME: reflects the miss. Real Neon DB; mc uses the DATABASE_URL fallback opt-in.

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
  const profileIds: string[] = [];
  const absentSkill = `mc-absent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'mc-resolve-skill-'));
    mkdirSync(join(repo, '.claude', 'skills', 'wd-skill'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'skills', 'wd-skill', 'SKILL.md'), '---\nname: wd-skill\ndescription: work-dir skill\n---\n');
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
  });

  it('reports present/source per declared skill and skillsResolved=false when one is missing', async () => {
    const prof = await createProfile({
      slug: `vt-resolve-prof-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: 'resolve skill report profile',
      matchRules: { projectSlugs: [slug] },
      priority: 5,
      skills: ['wd-skill', absentSkill],
    });
    profileIds.push(prof.id);

    const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const out = execFileSync(tsxBin, ['cli/index.ts', 'profile', 'resolve', '--project', slug, '--json'], {
      env: { ...process.env, MC_ALLOW_DATABASE_URL_FALLBACK: '1' },
      encoding: 'utf8',
      timeout: 55000,
    });
    const env = JSON.parse(out);
    expect(env.ok).toBe(true);
    expect(env.data.profile?.slug).toBe(prof.slug);

    const skills: { name: string; source: string | null; present: boolean }[] = env.data.skills;
    const wd = skills.find((s) => s.name === 'wd-skill');
    const absent = skills.find((s) => s.name === absentSkill);
    expect(wd).toEqual({ name: 'wd-skill', source: 'project', present: true });
    expect(absent).toEqual({ name: absentSkill, source: null, present: false });
    expect(env.data.skillsResolved).toBe(false);
  }, 60000);
});

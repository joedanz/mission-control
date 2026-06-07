// ABOUTME: Skill installer (lib/skills-install.ts) — GitHub content fetch + write into ~/.claude/skills.
// ABOUTME: Network is fully mocked (URL-routed global fetch); writes go to a tmp MC_CLAUDE_HOME fixture.
// ABOUTME: Covers happy install, subpath resolution, path-traversal rejection, frontmatter validation,
// ABOUTME: name safety, conflict/force, and the parseInstallTarget arg parser.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkill, parseInstallTarget } from '../lib/skills-install';
import { userSkillsDir } from '../lib/skills';
import { ValidationError, ConflictError } from '../lib/validation';

let home: string;

const SKILL_MD = (name: string) => `---\nname: ${name}\ndescription: A test skill\n---\n\nBody for ${name}.\n`;

/** Route a fetch mock by URL: repo meta (default_branch), recursive tree, and raw file contents. */
function mockGitHub(opts: { tree: { path: string; type: string }[]; files: Record<string, string>; branch?: string }) {
  const branch = opts.branch ?? 'main';
  const fn = vi.fn(async (url: string) => {
    const u = String(url);
    if (/\/git\/trees\//.test(u)) {
      return { ok: true, status: 200, json: async () => ({ tree: opts.tree, truncated: false }), text: async () => '' };
    }
    if (/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(u)) {
      return { ok: true, status: 200, json: async () => ({ default_branch: branch }), text: async () => '' };
    }
    if (u.startsWith('https://raw.githubusercontent.com/')) {
      const path = u.split(`/${branch}/`)[1];
      const content = opts.files[path];
      if (content === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => content,
        arrayBuffer: async () => new TextEncoder().encode(content).buffer,
      };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'unhandled' };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mc-skills-install-'));
  vi.stubEnv('MC_CLAUDE_HOME', home);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('parseInstallTarget', () => {
  it('parses owner/repo@slug', () => {
    expect(parseInstallTarget('vercel-labs/skills@find-skills')).toEqual({ source: 'vercel-labs/skills', slug: 'find-skills' });
  });
  it('parses owner/repo/slug (registry id)', () => {
    expect(parseInstallTarget('vercel-labs/skills/find-skills')).toMatchObject({ source: 'vercel-labs/skills', slug: 'find-skills' });
  });
  it('returns null for unparseable input', () => {
    expect(parseInstallTarget('justone')).toBeNull();
    expect(parseInstallTarget('owner/repo')).toBeNull();
    expect(parseInstallTarget('')).toBeNull();
  });
});

describe('installSkill', () => {
  it('resolves the skill subdir, fetches its files, and writes them under ~/.claude/skills/<slug>/', async () => {
    mockGitHub({
      tree: [
        { path: 'README.md', type: 'blob' },
        { path: 'skills/find-skills/SKILL.md', type: 'blob' },
        { path: 'skills/find-skills/reference/guide.md', type: 'blob' },
        { path: 'skills/other-skill/SKILL.md', type: 'blob' },
      ],
      files: {
        'skills/find-skills/SKILL.md': SKILL_MD('find-skills'),
        'skills/find-skills/reference/guide.md': '# Guide\n',
      },
    });
    const res = await installSkill({ source: 'vercel-labs/skills', slug: 'find-skills' });
    expect(res).toMatchObject({ slug: 'find-skills', fileCount: 2 });
    const dest = join(userSkillsDir(), 'find-skills');
    expect(res.path).toBe(dest);
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('name: find-skills');
    expect(readFileSync(join(dest, 'reference', 'guide.md'), 'utf8')).toBe('# Guide\n');
    // Did NOT pull the sibling skill or the repo README.
    expect(existsSync(join(dest, 'README.md'))).toBe(false);
  });

  it('resolves a single root-level SKILL.md repo (excludes VCS/build dirs)', async () => {
    mockGitHub({
      tree: [
        { path: 'SKILL.md', type: 'blob' },
        { path: 'helper.ts', type: 'blob' },
        { path: 'node_modules/dep/index.js', type: 'blob' },
      ],
      files: { 'SKILL.md': SKILL_MD('solo'), 'helper.ts': 'export {};\n' },
    });
    const res = await installSkill({ source: 'acme/solo-skill', slug: 'solo' });
    expect(res.fileCount).toBe(2);
    const dest = join(userSkillsDir(), 'solo');
    expect(existsSync(join(dest, 'helper.ts'))).toBe(true);
    expect(existsSync(join(dest, 'node_modules'))).toBe(false);
  });

  it('rejects a traversal path in the repo tree and writes nothing', async () => {
    mockGitHub({
      tree: [
        { path: 'skills/evil/SKILL.md', type: 'blob' },
        { path: 'skills/evil/../../../etc/passwd', type: 'blob' },
      ],
      files: { 'skills/evil/SKILL.md': SKILL_MD('evil') },
    });
    await expect(installSkill({ source: 'a/b', slug: 'evil' })).rejects.toBeInstanceOf(ValidationError);
    expect(existsSync(join(userSkillsDir(), 'evil'))).toBe(false);
  });

  it('rejects an unsafe slug before any network call', async () => {
    const fn = mockGitHub({ tree: [], files: {} });
    await expect(installSkill({ source: 'a/b', slug: '../escape' })).rejects.toBeInstanceOf(ValidationError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses a SKILL.md with no valid frontmatter and writes nothing', async () => {
    mockGitHub({
      tree: [{ path: 'skills/bad/SKILL.md', type: 'blob' }],
      files: { 'skills/bad/SKILL.md': 'no frontmatter here\n' },
    });
    await expect(installSkill({ source: 'a/b', slug: 'bad' })).rejects.toBeInstanceOf(ValidationError);
    expect(existsSync(join(userSkillsDir(), 'bad'))).toBe(false);
  });

  it('errors when no SKILL.md matches the slug and there are several', async () => {
    mockGitHub({
      tree: [
        { path: 'skills/one/SKILL.md', type: 'blob' },
        { path: 'skills/two/SKILL.md', type: 'blob' },
      ],
      files: { 'skills/one/SKILL.md': SKILL_MD('one'), 'skills/two/SKILL.md': SKILL_MD('two') },
    });
    await expect(installSkill({ source: 'a/b', slug: 'three' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('excludes a nested sub-skill’s files from the parent skill', async () => {
    mockGitHub({
      tree: [
        { path: 'skills/parent/SKILL.md', type: 'blob' },
        { path: 'skills/parent/doc.md', type: 'blob' },
        { path: 'skills/parent/inner/SKILL.md', type: 'blob' },
        { path: 'skills/parent/inner/extra.md', type: 'blob' },
      ],
      files: {
        'skills/parent/SKILL.md': SKILL_MD('parent'),
        'skills/parent/doc.md': '# doc\n',
      },
    });
    const res = await installSkill({ source: 'a/b', slug: 'parent' });
    expect(res.fileCount).toBe(2); // SKILL.md + doc.md, NOT the nested inner skill
    const dest = join(userSkillsDir(), 'parent');
    expect(existsSync(join(dest, 'inner'))).toBe(false);
  });

  it('refuses to overwrite an existing skill without force, and overwrites with force', async () => {
    const dest = join(userSkillsDir(), 'find-skills');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'SKILL.md'), '---\nname: find-skills\ndescription: old\n---\nold\n');
    const tree = [{ path: 'skills/find-skills/SKILL.md', type: 'blob' }];
    const files = { 'skills/find-skills/SKILL.md': SKILL_MD('find-skills') };

    mockGitHub({ tree, files });
    await expect(installSkill({ source: 'vercel-labs/skills', slug: 'find-skills' })).rejects.toBeInstanceOf(ConflictError);
    // Original preserved.
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('description: old');

    mockGitHub({ tree, files });
    await installSkill({ source: 'vercel-labs/skills', slug: 'find-skills' }, { force: true });
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('description: A test skill');
  });
});

// ABOUTME: Unit coverage for the filesystem skill resolver (lib/skills.ts) — scanSkillDirs, resolveSkills,
// ABOUTME: and parseSkillFrontmatter. Plants real SKILL.md files in tmp dirs (the brainstorm-probe model);
// ABOUTME: no DB, no spawn. Covers AE1 (all present), AE2 (missing), AE3 (work-dir source), precedence,
// ABOUTME: frontmatter edges, and the path-traversal guard.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillFrontmatter, resolveSkills, scanSkillDirs } from '../lib/skills';
import { ValidationError } from '../lib/validation';

let root: string;
let userDir: string;
let projDir: string;

/** Write `<base>/<name>/SKILL.md` with the given frontmatter. */
function plant(base: string, name: string, description = `desc for ${name}`, body = 'body'): void {
  mkdirSync(join(base, name), { recursive: true });
  writeFileSync(join(base, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mc-skills-test-'));
  userDir = join(root, 'user');
  projDir = join(root, 'project');
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scanSkillDirs', () => {
  it('lists each valid skill with parsed name, description, and source', () => {
    plant(userDir, 'ship', 'Ship workflow');
    plant(userDir, 'review', 'Structured review');
    const items = scanSkillDirs([{ dir: userDir, source: 'user' }]);
    expect(items).toHaveLength(2);
    expect(items.find((s) => s.name === 'ship')).toEqual({ name: 'ship', description: 'Ship workflow', source: 'user' });
    expect(items.find((s) => s.name === 'review')?.source).toBe('user');
  });

  it('skips a <name>/ dir with no SKILL.md', () => {
    plant(userDir, 'ship');
    mkdirSync(join(userDir, 'empty'), { recursive: true });
    const names = scanSkillDirs([{ dir: userDir, source: 'user' }]).map((s) => s.name);
    expect(names).toEqual(['ship']);
  });

  it('treats a nonexistent dir as empty without throwing', () => {
    expect(scanSkillDirs([{ dir: join(root, 'nope'), source: 'user' }])).toEqual([]);
  });

  it('lists a skill installed as a symlink to a directory, matching resolveSkills', () => {
    // A versioned skill lives outside the scan dir and is installed via a symlink — the
    // pattern the mission-control skill documents (repo source linked into ~/.claude/skills).
    const realBase = join(root, 'real');
    plant(realBase, 'mission-control', 'Drive the mc CLI');
    symlinkSync(join(realBase, 'mission-control'), join(userDir, 'mission-control'), 'dir');

    const names = scanSkillDirs([{ dir: userDir, source: 'user' }]).map((s) => s.name);
    expect(names).toContain('mission-control');

    // Invariant: the catalog must list exactly what resolveSkills can resolve (lib/skills.ts:128-137).
    const res = resolveSkills(['mission-control'], { dirs: [{ dir: userDir, source: 'user' }] });
    expect(res.resolved.map((r) => r.name)).toContain('mission-control');
  });

  it('lists a skill whose frontmatter is malformed, with an empty description (stays resolvable)', () => {
    mkdirSync(join(userDir, 'broken'), { recursive: true });
    writeFileSync(join(userDir, 'broken', 'SKILL.md'), 'no frontmatter here\n');
    const broken = scanSkillDirs([{ dir: userDir, source: 'user' }]).find((s) => s.name === 'broken');
    expect(broken).toEqual({ name: 'broken', description: '', source: 'user' });
  });

  it('dedupes by name with user precedence (declaration order)', () => {
    plant(userDir, 'shared', 'user copy');
    plant(projDir, 'shared', 'project copy');
    const items = scanSkillDirs([
      { dir: userDir, source: 'user' },
      { dir: projDir, source: 'project' },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ name: 'shared', description: 'user copy', source: 'user' });
  });
});

describe('resolveSkills', () => {
  it('resolves all declared filesystem skills present in the user dir', () => {
    plant(userDir, 'ship');
    plant(userDir, 'review');
    const r = resolveSkills(['ship', 'review'], { dirs: [{ dir: userDir, source: 'user' }] });
    expect(r.unresolved).toEqual([]);
    expect(r.resolved).toEqual([
      { name: 'ship', source: 'user' },
      { name: 'review', source: 'user' },
    ]);
  });

  it('reports a filesystem skill absent from every dir as unresolved with reason not-found', () => {
    plant(userDir, 'ship');
    const r = resolveSkills(['ship', 'investigate'], { dirs: [{ dir: userDir, source: 'user' }] });
    expect(r.unresolved).toEqual([{ name: 'investigate', reason: 'not-found' }]);
    expect(r.resolved).toEqual([{ name: 'ship', source: 'user' }]);
  });

  it('resolves a work-dir skill with source=project when the user dir lacks it', () => {
    plant(projDir, 'deploy-helper');
    const r = resolveSkills(['deploy-helper'], {
      dirs: [
        { dir: userDir, source: 'user' },
        { dir: projDir, source: 'project' },
      ],
    });
    expect(r.unresolved).toEqual([]);
    expect(r.resolved).toEqual([{ name: 'deploy-helper', source: 'project' }]);
  });

  it('prefers the user source when a name exists in both', () => {
    plant(userDir, 'shared');
    plant(projDir, 'shared');
    const r = resolveSkills(['shared'], {
      dirs: [
        { dir: userDir, source: 'user' },
        { dir: projDir, source: 'project' },
      ],
    });
    expect(r.resolved).toEqual([{ name: 'shared', source: 'user' }]);
  });

  it('throws ValidationError on a path-traversal or malformed name (flat or plugin form)', () => {
    for (const bad of ['../evil', 'a/b', '..', '/etc/passwd', 'a:b:c', ':foo', 'foo:', 'plugin:../x']) {
      expect(() => resolveSkills([bad], { dirs: [{ dir: userDir, source: 'user' }] })).toThrow(ValidationError);
    }
  });

  it('routes a plugin reference to the injected resolvePlugin (source=plugin + marketplace)', () => {
    const resolvePlugin = (plugin: string, skill: string) =>
      plugin === 'demo' && skill === 'do-thing'
        ? { resolved: true, marketplace: 'mkt-a' }
        : { resolved: false, reason: 'skill-not-found' as const };
    const r = resolveSkills(['demo:do-thing', 'demo:missing'], { dirs: [], resolvePlugin });
    expect(r.resolved).toEqual([{ name: 'demo:do-thing', source: 'plugin', marketplace: 'mkt-a' }]);
    expect(r.unresolved).toEqual([{ name: 'demo:missing', reason: 'skill-not-found' }]);
  });

  it('routes a flat name and a plugin name independently in one mixed call (AE7)', () => {
    plant(userDir, 'ship');
    const resolvePlugin = () => ({ resolved: true, marketplace: 'mkt-a' });
    const r = resolveSkills(['ship', 'compound-engineering:ce-work'], { dirs: [{ dir: userDir, source: 'user' }], resolvePlugin });
    expect(r.unresolved).toEqual([]);
    expect(r.resolved).toEqual([
      { name: 'ship', source: 'user' },
      { name: 'compound-engineering:ce-work', source: 'plugin', marketplace: 'mkt-a' },
    ]);
  });

  it('reports a plugin reference as plugin-not-installed when no resolver is injected', () => {
    const r = resolveSkills(['demo:do-thing'], { dirs: [] });
    expect(r.resolved).toEqual([]);
    expect(r.unresolved).toEqual([{ name: 'demo:do-thing', reason: 'plugin-not-installed' }]);
  });
});

describe('parseSkillFrontmatter', () => {
  it('parses name and description from a well-formed block', () => {
    expect(parseSkillFrontmatter('---\nname: ship\ndescription: Ship it\n---\nbody')).toEqual({
      name: 'ship',
      description: 'Ship it',
    });
  });

  it('strips surrounding quotes and collapses whitespace in description', () => {
    expect(parseSkillFrontmatter('---\nname: x\ndescription: "a   b"\n---\n').description).toBe('a b');
  });

  it('throws when there is no frontmatter block', () => {
    expect(() => parseSkillFrontmatter('just text\n')).toThrow(ValidationError);
  });

  it('throws when name is missing', () => {
    expect(() => parseSkillFrontmatter('---\ndescription: d\n---\n')).toThrow(ValidationError);
  });

  it('throws when description is missing or empty', () => {
    expect(() => parseSkillFrontmatter('---\nname: x\n---\n')).toThrow(ValidationError);
    expect(() => parseSkillFrontmatter('---\nname: x\ndescription:\n---\n')).toThrow(ValidationError);
  });

  it('throws when the frontmatter block is unclosed', () => {
    expect(() => parseSkillFrontmatter('---\nname: x\ndescription: d\n')).toThrow(ValidationError);
  });
});

// ABOUTME: Unit coverage for the filesystem skill resolver (lib/skills.ts) — scanSkillDirs, resolveSkills,
// ABOUTME: and parseSkillFrontmatter. Plants real SKILL.md files in tmp dirs (the brainstorm-probe model);
// ABOUTME: no DB, no spawn. Covers AE1 (all present), AE2 (missing), AE3 (work-dir source), precedence,
// ABOUTME: frontmatter edges, and the path-traversal guard.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  it('resolves all declared skills present in the user dir (AE1)', () => {
    plant(userDir, 'ship');
    plant(userDir, 'review');
    const r = resolveSkills(['ship', 'review'], [{ dir: userDir, source: 'user' }]);
    expect(r.missing).toEqual([]);
    expect(r.resolved).toEqual([
      { name: 'ship', source: 'user' },
      { name: 'review', source: 'user' },
    ]);
  });

  it('reports a declared skill absent from every dir as missing (AE2)', () => {
    plant(userDir, 'ship');
    const r = resolveSkills(['ship', 'investigate'], [{ dir: userDir, source: 'user' }]);
    expect(r.missing).toEqual(['investigate']);
    expect(r.resolved).toEqual([{ name: 'ship', source: 'user' }]);
  });

  it('resolves a work-dir skill with source=project when the user dir lacks it (AE3)', () => {
    plant(projDir, 'deploy-helper');
    const r = resolveSkills(['deploy-helper'], [
      { dir: userDir, source: 'user' },
      { dir: projDir, source: 'project' },
    ]);
    expect(r.missing).toEqual([]);
    expect(r.resolved).toEqual([{ name: 'deploy-helper', source: 'project' }]);
  });

  it('prefers the user source when a name exists in both', () => {
    plant(userDir, 'shared');
    plant(projDir, 'shared');
    const r = resolveSkills(['shared'], [
      { dir: userDir, source: 'user' },
      { dir: projDir, source: 'project' },
    ]);
    expect(r.resolved).toEqual([{ name: 'shared', source: 'user' }]);
  });

  it('throws ValidationError on a path-traversal skill name', () => {
    for (const bad of ['../evil', 'a/b', '..', '/etc/passwd']) {
      expect(() => resolveSkills([bad], [{ dir: userDir, source: 'user' }])).toThrow(ValidationError);
    }
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

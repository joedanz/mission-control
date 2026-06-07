// ABOUTME: Filesystem skill resolver — the single source of truth for "which Claude Code skills exist"
// ABOUTME: shared by the daemon spawn path (enforce a profile's declared skills), `mc skill list` (catalog),
// ABOUTME: and `mc profile resolve` (preflight report). Claude Code discovers skills as `<dir>/<name>/SKILL.md`
// ABOUTME: under ~/.claude/skills (user) and <cwd>/.claude/skills (project); we resolve against the same two
// ABOUTME: locations so the catalog can never diverge from what a spawn will actually discover. No DB, no spawn.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ValidationError } from './validation';

export type SkillSource = 'user' | 'project';

/** One discovery location to scan, tagged with the source it represents. Callers pass these in declaration
 *  order; precedence on a name collision follows that order (user first → user wins). */
export type SkillDir = { dir: string; source: SkillSource };

/** A discovered skill: its directory name (how a profile references it), its frontmatter description, and
 *  which location it came from. */
export type SkillInfo = { name: string; description: string; source: SkillSource };

export type SkillResolution = {
  resolved: { name: string; source: SkillSource }[];
  missing: string[];
};

/** A skill name is path-joined into `<dir>/<name>/SKILL.md`. `profiles.skills` is free-text from the DB, so a
 *  name with a separator or `..` could escape the skills tree — restrict to a flat, safe token. */
const SKILL_NAME_RE = /^[A-Za-z0-9_-]+$/;

const MAX_DESCRIPTION = 1024; // mirrors the Agent Skills frontmatter `description` limit

/** The Claude Code config root (`~/.claude`). `MC_CLAUDE_HOME` overrides it explicitly — read directly
 *  (NOT via `$HOME`, which `homedir()` doesn't reliably honor on macOS), mirroring the `MC_CLAUDE_BIN` /
 *  `MC_BIN` precedent. This single seam makes every config-relative path (user skills, plugin settings,
 *  the install registry) point at a tmp fixture under test. */
export function claudeHome(): string {
  return process.env.MC_CLAUDE_HOME || join(homedir(), '.claude');
}

/** The per-user skills directory Claude Code discovers by default (`~/.claude/skills`). */
export function userSkillsDir(): string {
  return join(claudeHome(), 'skills');
}

/** Reject a declared skill name that could traverse outside the skills tree. Returns the name unchanged when
 *  safe; throws ValidationError otherwise (the CLI maps this to exit code 2). */
export function assertSafeSkillName(name: string): string {
  if (!SKILL_NAME_RE.test(name)) {
    throw new ValidationError('skill', `Invalid skill name "${name}". Allowed: letters, digits, hyphen, underscore`);
  }
  return name;
}

/** Parse a SKILL.md's leading `---` frontmatter block for `name` + `description`. Hand-rolled (the repo keeps a
 *  lean dependency set and skill frontmatter is flat `key: value`); throws ValidationError when the block is
 *  absent or either field is empty. The body after the second `---` is ignored. */
export function parseSkillFrontmatter(text: string, context = 'SKILL.md'): { name: string; description: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    throw new ValidationError('skill', `${context} has no frontmatter block`);
  }
  const fields: Record<string, string> = {};
  let closed = false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closed = true;
      break;
    }
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) fields[m[1]] = stripQuotes(m[2].trim());
  }
  if (!closed) throw new ValidationError('skill', `${context} frontmatter block is not closed`);
  const name = fields.name ?? '';
  const description = fields.description ?? '';
  if (!name) throw new ValidationError('skill', `${context} frontmatter is missing "name"`);
  if (!description) throw new ValidationError('skill', `${context} frontmatter is missing "description"`);
  return { name, description: sanitizeDescription(description) };
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Single-line, length-capped — the description is spliced into event summaries and catalog output, so strip
 *  newlines and cap length before it travels downstream. */
function sanitizeDescription(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
}

/** Does `<dir>/<name>/SKILL.md` exist? The shared existence predicate behind both resolution and the catalog —
 *  keeping them on one check is what guarantees the catalog never lists a skill a spawn can't discover. */
function skillFilePresent(dir: string, name: string): boolean {
  return existsSync(join(dir, name, 'SKILL.md'));
}

/** Enumerate every skill discoverable under `dirs`, newest source precedence first (a name in two dirs is
 *  listed once, from the first dir that has it). Resilient: a missing dir, a non-directory entry, an unsafe
 *  entry name, or an unparseable SKILL.md is skipped rather than thrown — a single bad skill must not break
 *  the catalog. The set of names returned equals the set `resolveSkills` would resolve. */
export function scanSkillDirs(dirs: SkillDir[]): SkillInfo[] {
  const seen = new Set<string>();
  const out: SkillInfo[] = [];
  for (const { dir, source } of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue; // dir doesn't exist / unreadable
    }
    for (const name of entries) {
      if (seen.has(name) || !SKILL_NAME_RE.test(name) || !skillFilePresent(dir, name)) continue;
      seen.add(name);
      out.push({ name, description: readDescription(join(dir, name, 'SKILL.md')), source });
    }
  }
  return out;
}

/** Best-effort description for the catalog — never throws, so a malformed SKILL.md still lists (and stays
 *  resolvable) with an empty description rather than vanishing from the catalog. */
function readDescription(skillPath: string): string {
  try {
    return parseSkillFrontmatter(readFileSync(skillPath, 'utf8'), skillPath).description;
  } catch {
    return '';
  }
}

/** Resolve a profile's declared skill names against `dirs`. Each name is validated (throws ValidationError on
 *  an unsafe name) then checked for `<dir>/<name>/SKILL.md` in declaration order; the first hit wins. Returns
 *  the resolved names (with their source) and any that exist in none of the dirs. */
export function resolveSkills(declared: string[], dirs: SkillDir[]): SkillResolution {
  const resolved: { name: string; source: SkillSource }[] = [];
  const missing: string[] = [];
  for (const name of declared) {
    assertSafeSkillName(name);
    const hit = dirs.find((d) => skillFilePresent(d.dir, name));
    if (hit) resolved.push({ name, source: hit.source });
    else missing.push(name);
  }
  return { resolved, missing };
}

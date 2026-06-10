// ABOUTME: Installs a skill from its public GitHub repo into ~/.claude/skills/<slug>/ — the one place mc
// ABOUTME: writes into the Claude Code config tree. Resolves the skill's subdirectory from the repo tree,
// ABOUTME: fetches each file (raw.githubusercontent), validates name safety + SKILL.md frontmatter + per-file
// ABOUTME: path traversal, then writes atomically (temp dir + rename). No DB, no git binary, no skills.sh auth
// ABOUTME: (content comes from GitHub; an optional GITHUB_TOKEN only lifts rate limits). All paths route
// ABOUTME: through claudeHome()/userSkillsDir() so MC_CLAUDE_HOME redirects installs under test.

import { existsSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { ValidationError, ConflictError } from './validation';
import { GitHubApiError } from './github-api';
import { assertSafeSkillName, parseSkillFrontmatter, userSkillsDir } from './skills';
import { parseRegistryId } from './skills-registry';

/** GitHub origins, read at call time so MC_GITHUB_API_URL / MC_GITHUB_RAW_URL can redirect them at a local
 *  mock server under test (mirrors the SKILLS_API_URL seam). Default to the real GitHub. */
function githubApi(): string {
  return process.env.MC_GITHUB_API_URL || 'https://api.github.com';
}
function githubRaw(): string {
  return process.env.MC_GITHUB_RAW_URL || 'https://raw.githubusercontent.com';
}

/** Top-level directories never copied into a skill (relevant only for a root-level skill repo). */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** What to install: the GitHub repo (`owner/repo`) and the skill's directory name (`slug`). */
export type InstallTarget = { source: string; slug: string; id?: string };

export type InstallResult = { slug: string; path: string; fileCount: number; source: string };

/** Parse a `mc skill add` argument into an install target. Accepts `owner/repo@slug` and the registry id form
 *  `owner/repo/slug`. Returns null when neither shape matches. Pure. */
export function parseInstallTarget(arg: string): InstallTarget | null {
  const at = arg.indexOf('@');
  if (at > 0) {
    const source = arg.slice(0, at);
    const slug = arg.slice(at + 1);
    if (/^[^/]+\/[^/]+$/.test(source) && slug) return { source, slug };
    return null;
  }
  const parsed = parseRegistryId(arg);
  return parsed ? { ...parsed, id: arg } : null;
}

type TreeEntry = { path: string; type: string };

function ghHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'mission-control-mc', Accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function ghJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers: ghHeaders() });
  } catch (e) {
    throw new GitHubApiError(`GitHub request failed: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GitHubApiError(`GitHub ${res.status} for ${url}: ${body.slice(0, 200)}`, res.status);
  }
  return res.json();
}

/** Encode each path segment but keep the `/` separators — a file path / branch / `owner/repo` with a '#',
 *  '?', '%' or space would otherwise truncate or mis-route the raw.githubusercontent URL (e.g. a '#' is read
 *  as a URL fragment) and fetch the wrong resource → a spurious 404. */
function encPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** Fetch a repo file as raw bytes (not decoded text) so binary assets in a skill survive the write intact. */
async function ghRawBytes(source: string, branch: string, path: string): Promise<Buffer> {
  const res = await fetch(`${githubRaw()}/${encPath(source)}/${encPath(branch)}/${encPath(path)}`, { headers: ghHeaders() });
  if (!res.ok) throw new GitHubApiError(`GitHub raw ${res.status} for ${path}`, res.status);
  return Buffer.from(await res.arrayBuffer());
}

/** Reject a repo-relative file path that would escape the skill directory; return it unchanged when safe. */
function assertSafeRelPath(rel: string): string {
  const segments = rel.replace(/\\/g, '/').split('/');
  if (rel.startsWith('/') || segments.some((s) => s === '..' || s === '')) {
    throw new ValidationError('path', `unsafe file path in skill: "${rel}"`);
  }
  return rel;
}

/** Every directory in the repo tree that holds a SKILL.md ('' for a root SKILL.md). */
function skillDirsOf(tree: TreeEntry[]): string[] {
  return tree
    .filter((t) => t.type === 'blob' && (t.path === 'SKILL.md' || t.path.endsWith('/SKILL.md')))
    .map((t) => (t.path === 'SKILL.md' ? '' : t.path.slice(0, -'/SKILL.md'.length)));
}

/** Pick the skill directory whose basename matches `slug`; fall back to the sole skill in the repo. Returns the
 *  directory prefix ('' for a root skill). Throws ValidationError when nothing usable is found. */
function resolveSkillDir(skillDirs: string[], slug: string): string {
  if (skillDirs.length === 0) throw new ValidationError('source', 'no SKILL.md found in repository');
  const byName = skillDirs.find((dir) => dir.split('/').pop() === slug);
  if (byName !== undefined) return byName;
  if (skillDirs.length === 1) return skillDirs[0];
  throw new ValidationError('slug', `no skill "${slug}" in repository (found: ${skillDirs.map((d) => d.split('/').pop()).join(', ')})`);
}

/** Files belonging to the skill at `dir`: blobs under the dir prefix, minus VCS/build dirs and any files that
 *  belong to a NESTED skill (a deeper directory with its own SKILL.md — that is a separate skill, not ours). */
function skillFiles(tree: TreeEntry[], dir: string, nestedSkillDirs: string[]): string[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  return tree
    .filter((t) => t.type === 'blob' && t.path.startsWith(prefix))
    .map((t) => t.path)
    .filter((path) => {
      const rel = path.slice(prefix.length);
      if (SKIP_DIRS.has(rel.split('/')[0])) return false;
      return !nestedSkillDirs.some((nested) => path === `${nested}/SKILL.md` || path.startsWith(`${nested}/`));
    });
}

/** Install a skill from its GitHub repo into ~/.claude/skills/<slug>/. Validates name safety up front, then
 *  resolves the skill's subdir, fetches + validates its files, and swaps them into place atomically. */
export async function installSkill(target: InstallTarget, opts?: { force?: boolean }): Promise<InstallResult> {
  const { source, slug } = target;
  assertSafeSkillName(slug); // throws before any network call

  const meta = (await ghJson(`${githubApi()}/repos/${source}`)) as { default_branch?: string };
  const branch = meta.default_branch || 'main';
  const treeJson = (await ghJson(`${githubApi()}/repos/${source}/git/trees/${branch}?recursive=1`)) as {
    tree?: TreeEntry[];
    truncated?: boolean;
  };
  if (treeJson.truncated) {
    throw new ValidationError('source', `repository tree is too large to enumerate (truncated): ${source}`);
  }
  const tree = treeJson.tree ?? [];
  const skillDirs = skillDirsOf(tree);
  const dir = resolveSkillDir(skillDirs, slug);
  const prefix = dir === '' ? '' : `${dir}/`;
  // A skill directory nested INSIDE ours is a separate skill — its files must not be folded into this one.
  const nested = skillDirs.filter((d) => d !== dir && d.startsWith(prefix) && d.length > prefix.length);

  const files = skillFiles(tree, dir, nested);
  const skillMdPath = `${prefix}SKILL.md`;
  if (!files.includes(skillMdPath)) throw new ValidationError('source', 'resolved skill has no SKILL.md');

  // Fetch + validate the SKILL.md before touching disk (bytes preserved so a binary asset survives the write).
  const skillMdBytes = await ghRawBytes(source, branch, skillMdPath);
  parseSkillFrontmatter(skillMdBytes.toString('utf8'), `${slug}/SKILL.md`); // throws ValidationError on bad frontmatter

  const dest = join(userSkillsDir(), slug);
  if (existsSync(dest) && !opts?.force) {
    throw new ConflictError('skill', `skill "${slug}" already installed at ${dest} (use --force to overwrite)`);
  }

  // Stage into a temp sibling dir, then swap — a crashed fetch never leaves a half-written skill in place.
  const staging = join(userSkillsDir(), `.${slug}.mc-install.${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  try {
    for (const path of files) {
      const rel = assertSafeRelPath(path.slice(prefix.length));
      const abs = join(staging, rel);
      assertWithin(staging, abs);
      const content = path === skillMdPath ? skillMdBytes : await ghRawBytes(source, branch, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    mkdirSync(dirname(dest), { recursive: true });
    // Move the existing skill aside FIRST, then swap in the new one — so an interrupt during --force overwrite
    // can never leave the user with no skill at all; on failure the backup is restored.
    const backup = existsSync(dest) ? `${dest}.mc-bak.${process.pid}` : null;
    if (backup) renameSync(dest, backup);
    try {
      renameSync(staging, dest);
    } catch (e) {
      if (backup) renameSync(backup, dest);
      throw e;
    }
    if (backup) rmSync(backup, { recursive: true, force: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return { slug, path: dest, fileCount: files.length, source };
}

/** Guard that a resolved write path stays within the staging base (defense in depth over assertSafeRelPath). */
function assertWithin(base: string, target: string): void {
  const b = resolve(base);
  const t = resolve(target);
  if (t !== b && !t.startsWith(b + sep)) {
    throw new ValidationError('path', `refusing to write outside the skill directory: ${target}`);
  }
}

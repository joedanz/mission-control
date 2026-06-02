// ABOUTME: Thin GitHub helper — parse a repo from a project's repoUrl + list its issues via the `gh` CLI.
// ABOUTME: No DB, no deps, no token handling: shells out to `gh` (already authenticated for the operator).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export type GitHubRepo = { owner: string; repo: string };
export type GitHubIssue = { number: number; title: string; url: string };

/** Raised for any `gh` failure (missing binary, auth, repo-not-found, bad output). The CLI maps it to
 *  a GITHUB error code so the operator sees gh's own message, not a generic DB error. */
export class GitHubError extends Error {}

/** Parse `owner/repo` from the repoUrl forms we store (https / git@ / bare). null if it isn't GitHub. */
export function parseGitHubRepo(repoUrl: string | null | undefined): GitHubRepo | null {
  if (!repoUrl) return null;
  const s = repoUrl.trim().replace(/\.git$/i, '');
  // https://github.com/owner/repo  |  git@github.com:owner/repo  |  github.com/owner/repo
  const host = s.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
  if (host) return { owner: host[1], repo: host[2] };
  // bare "owner/repo"
  const bare = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (bare) return { owner: bare[1], repo: bare[2] };
  return null;
}

/** List a repo's issues via `gh issue list` (PRs are excluded — gh's issue list is issues-only).
 *  Throws GitHubError on any failure. */
export async function listIssues(
  repo: GitHubRepo,
  opts: { state?: 'open' | 'closed' | 'all'; limit?: number; label?: string } = {},
): Promise<GitHubIssue[]> {
  const args = [
    'issue', 'list',
    '--repo', `${repo.owner}/${repo.repo}`,
    '--state', opts.state ?? 'open',
    '--limit', String(opts.limit ?? 100),
    '--json', 'number,title,url',
  ];
  if (opts.label) args.push('--label', opts.label);

  let stdout: string;
  try {
    ({ stdout } = await execFileP('gh', args, { maxBuffer: 16 * 1024 * 1024 }));
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message?: string };
    if (e.code === 'ENOENT') throw new GitHubError('the `gh` CLI is not installed or not on PATH');
    throw new GitHubError((e.stderr || e.message || String(err)).trim());
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout || '[]');
  } catch {
    throw new GitHubError('could not parse `gh issue list` output as JSON');
  }
  if (!Array.isArray(parsed)) throw new GitHubError('unexpected `gh issue list` output (not an array)');
  return (parsed as GitHubIssue[]).map((i) => ({ number: i.number, title: i.title, url: i.url }));
}

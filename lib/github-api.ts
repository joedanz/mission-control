// ABOUTME: GitHub REST API client for the web UI — fetches commits and diffs via GITHUB_TOKEN.
// ABOUTME: Uses fetch (not gh CLI), so it works on Vercel. Re-uses GitHubRepo type from lib/github.

import type { GitHubRepo } from './github';

export type GitHubCommit = {
  sha: string;
  shortSha: string;
  message: string;
  body: string;
  authorName: string;
  authorDate: string;
  url: string;
  stats: { additions: number; deletions: number; total: number };
};

export type GitHubCommitFile = {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  patch?: string;
};

export type GitHubCommitDetail = GitHubCommit & { files: GitHubCommitFile[] };

export type GitHubPR = {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  draft: boolean;
  author: string;
  headBranch: string;
  baseBranch: string;
  labels: string[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  url: string;
};

export type GitHubPRReview = {
  id: number;
  author: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  body: string;
  submittedAt: string;
};

export type GitHubCheckRun = {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | null;
  url: string;
};

export type GitHubPRDetail = GitHubPR & {
  additions: number;
  deletions: number;
  changedFiles: number;
  reviews: GitHubPRReview[];
  checkRuns: GitHubCheckRun[];
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | null;
  ciStatus: 'success' | 'failure' | 'pending' | 'neutral' | null;
};

function deriveReviewDecision(reviews: GitHubPRReview[]): 'APPROVED' | 'CHANGES_REQUESTED' | null {
  const byAuthor = new Map<string, 'APPROVED' | 'CHANGES_REQUESTED'>();
  for (const r of reviews) {
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') {
      byAuthor.set(r.author, r.state);
    }
  }
  const states = [...byAuthor.values()];
  if (states.length === 0) return null;
  if (states.some((s) => s === 'CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  return 'APPROVED';
}

function deriveCiStatus(checkRuns: GitHubCheckRun[]): GitHubPRDetail['ciStatus'] {
  if (checkRuns.length === 0) return null;
  if (checkRuns.some((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out')) return 'failure';
  if (checkRuns.some((r) => r.status !== 'completed')) return 'pending';
  if (checkRuns.some((r) => r.conclusion === 'success')) return 'success';
  return 'neutral';
}

type RawPR = {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  draft?: boolean;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  labels: Array<{ name: string }>;
  comments: number;
  created_at: string;
  updated_at: string;
  html_url: string;
};

function mapRawPR(raw: RawPR): GitHubPR {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state as 'open' | 'closed',
    merged: raw.merged_at !== null,
    mergedAt: raw.merged_at ?? null,
    draft: raw.draft ?? false,
    author: raw.user?.login ?? 'unknown',
    headBranch: raw.head.ref,
    baseBranch: raw.base.ref,
    labels: raw.labels.map((l) => l.name),
    commentCount: raw.comments,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    url: raw.html_url,
  };
}

export class GitHubApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

async function ghFetch(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const tok = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (tok) headers.Authorization = `Bearer ${tok}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`https://api.github.com${path}`, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GitHubApiError(`GitHub API ${res.status}: ${body.slice(0, 200)}`, res.status);
  }
  return res.json();
}

export async function listCommits(
  repo: GitHubRepo,
  opts: { perPage?: number } = {},
): Promise<GitHubCommit[]> {
  const perPage = opts.perPage ?? 20;
  const data = await ghFetch(`/repos/${repo.owner}/${repo.repo}/commits?per_page=${perPage}`) as Array<{
    sha: string;
    commit: { message: string; author: { name: string; date: string } | null };
    html_url: string;
    stats?: { additions: number; deletions: number; total: number };
  }>;

  return data.map((c) => {
    const [message = '', ...bodyLines] = c.commit.message.split('\n');
    return {
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message,
      body: bodyLines.join('\n').trim(),
      authorName: c.commit.author?.name ?? 'Unknown',
      authorDate: c.commit.author?.date ?? '',
      url: c.html_url,
      stats: c.stats ?? { additions: 0, deletions: 0, total: 0 },
    };
  });
}

export async function getCommitDetail(repo: GitHubRepo, sha: string): Promise<GitHubCommitDetail> {
  const c = await ghFetch(`/repos/${repo.owner}/${repo.repo}/commits/${sha}`) as {
    sha: string;
    commit: { message: string; author: { name: string; date: string } | null };
    html_url: string;
    stats: { additions: number; deletions: number; total: number };
    files?: Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
    }>;
  };

  const [message = '', ...bodyLines] = c.commit.message.split('\n');
  return {
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    message,
    body: bodyLines.join('\n').trim(),
    authorName: c.commit.author?.name ?? 'Unknown',
    authorDate: c.commit.author?.date ?? '',
    url: c.html_url,
    stats: c.stats ?? { additions: 0, deletions: 0, total: 0 },
    files: (c.files ?? []).map((f) => ({
      filename: f.filename,
      status: f.status as GitHubCommitFile['status'],
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    })),
  };
}

export async function listPulls(
  repo: GitHubRepo,
  opts: { mergedDays?: number } = {},
): Promise<{ open: GitHubPR[]; recentlyMerged: GitHubPR[] }> {
  const mergedDays = opts.mergedDays ?? 7;
  const cutoff = new Date(Date.now() - mergedDays * 24 * 60 * 60 * 1000).toISOString();

  const [openRaw, closedRaw] = await Promise.all([
    ghFetch(`/repos/${repo.owner}/${repo.repo}/pulls?state=open&per_page=50&sort=updated`),
    ghFetch(`/repos/${repo.owner}/${repo.repo}/pulls?state=closed&per_page=100&sort=updated&direction=desc`),
  ]) as [RawPR[], RawPR[]];

  return {
    open: openRaw.map(mapRawPR),
    recentlyMerged: closedRaw
      .filter((pr) => pr.merged_at !== null && pr.merged_at >= cutoff)
      .sort((a, b) => (b.merged_at ?? '').localeCompare(a.merged_at ?? ''))
      .map(mapRawPR),
  };
}

export async function getPullReviews(repo: GitHubRepo, prNumber: number): Promise<GitHubPRReview[]> {
  const data = await ghFetch(
    `/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/reviews?per_page=100`,
  ) as Array<{
    id: number;
    user: { login: string } | null;
    state: string;
    body: string;
    submitted_at: string;
  }>;
  return data.map((r) => ({
    id: r.id,
    author: r.user?.login ?? 'unknown',
    state: r.state as GitHubPRReview['state'],
    body: r.body,
    submittedAt: r.submitted_at,
  }));
}

export async function getPullChecks(repo: GitHubRepo, sha: string): Promise<GitHubCheckRun[]> {
  const data = await ghFetch(
    `/repos/${repo.owner}/${repo.repo}/commits/${sha}/check-runs?per_page=100`,
  ) as { check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string }> };
  return data.check_runs.map((r) => ({
    name: r.name,
    status: r.status as GitHubCheckRun['status'],
    conclusion: (r.conclusion ?? null) as GitHubCheckRun['conclusion'],
    url: r.html_url,
  }));
}

export async function createReview(
  repo: GitHubRepo,
  prNumber: number,
  opts: { event: 'APPROVE' | 'REQUEST_CHANGES'; body?: string },
): Promise<void> {
  await ghFetch(`/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}/reviews`, {
    method: 'POST',
    body: { event: opts.event, ...(opts.body !== undefined ? { body: opts.body } : {}) },
  });
}

export async function closePull(repo: GitHubRepo, prNumber: number): Promise<void> {
  await ghFetch(`/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}`, {
    method: 'PATCH',
    body: { state: 'closed' },
  });
}

export async function getPull(repo: GitHubRepo, prNumber: number): Promise<GitHubPRDetail> {
  const rawPR = await ghFetch(
    `/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}`,
  ) as RawPR & { additions: number; deletions: number; changed_files: number };

  const [reviews, checkRuns] = await Promise.all([
    getPullReviews(repo, prNumber),
    getPullChecks(repo, rawPR.head.sha),
  ]);

  return {
    ...mapRawPR(rawPR),
    additions: rawPR.additions,
    deletions: rawPR.deletions,
    changedFiles: rawPR.changed_files,
    reviews,
    checkRuns,
    reviewDecision: deriveReviewDecision(reviews),
    ciStatus: deriveCiStatus(checkRuns),
  };
}

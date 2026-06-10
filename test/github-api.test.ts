// ABOUTME: Unit tests for lib/github-api — mocks globalThis.fetch; no network calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  listCommits, getCommitDetail,
  listPulls, getPullReviews, getPullChecks, getPull,
  createReview, closePull,
  GitHubApiError,
} from '../lib/github-api';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function stubResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function stubFetch(body: unknown, status = 200): FetchLike {
  return vi.fn().mockResolvedValue(stubResponse(body, status));
}

// Returns each body in order across successive fetch calls (for functions that fan out).
function stubFetchSequence(...bodies: unknown[]): FetchLike {
  let i = 0;
  return vi.fn().mockImplementation(() => Promise.resolve(stubResponse(bodies[i++])));
}

const REPO = { owner: 'acme', repo: 'widget' };

const RAW_COMMIT = {
  sha: 'abc1234567890def',
  commit: {
    message: 'feat: add widget\n\nClose #42',
    author: { name: 'Joe', date: '2026-01-01T00:00:00Z' },
  },
  html_url: 'https://github.com/acme/widget/commit/abc1234567890def',
  stats: { additions: 5, deletions: 2, total: 7 },
};

describe('listCommits', () => {
  let saved: FetchLike;
  beforeEach(() => { saved = globalThis.fetch as unknown as FetchLike; });
  afterEach(() => { globalThis.fetch = saved as unknown as typeof fetch; });

  it('maps GitHub response to GitHubCommit[]', async () => {
    globalThis.fetch = stubFetch([RAW_COMMIT]) as unknown as typeof fetch;
    const commits = await listCommits(REPO);
    expect(commits).toHaveLength(1);
    const c = commits[0];
    expect(c.sha).toBe('abc1234567890def');
    expect(c.shortSha).toBe('abc1234');
    expect(c.message).toBe('feat: add widget');
    expect(c.body).toBe('Close #42');
    expect(c.authorName).toBe('Joe');
    expect(c.stats.additions).toBe(5);
  });

  it('throws GitHubApiError on non-2xx', async () => {
    globalThis.fetch = stubFetch({ message: 'Not Found' }, 404) as unknown as typeof fetch;
    await expect(listCommits(REPO)).rejects.toBeInstanceOf(GitHubApiError);
  });

  it('attaches Authorization header when GITHUB_TOKEN is set', async () => {
    const spy = stubFetch([RAW_COMMIT]);
    globalThis.fetch = spy as unknown as typeof fetch;
    const prev = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_test123';
    try {
      await listCommits(REPO);
      const init = (spy as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_test123');
    } finally {
      if (prev === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prev;
    }
  });

  it('omits Authorization header when GITHUB_TOKEN is absent', async () => {
    const spy = stubFetch([RAW_COMMIT]);
    globalThis.fetch = spy as unknown as typeof fetch;
    const prev = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      await listCommits(REPO);
      const init = (spy as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.GITHUB_TOKEN = prev;
    }
  });
});

describe('getCommitDetail', () => {
  let saved: FetchLike;
  beforeEach(() => { saved = globalThis.fetch as unknown as FetchLike; });
  afterEach(() => { globalThis.fetch = saved as unknown as typeof fetch; });

  it('includes files and patch', async () => {
    const detail = {
      ...RAW_COMMIT,
      files: [{
        filename: 'src/widget.ts',
        status: 'modified',
        additions: 5,
        deletions: 2,
        patch: '@@ -1,2 +1,5 @@\n-old\n+new',
      }],
    };
    globalThis.fetch = stubFetch(detail) as unknown as typeof fetch;
    const result = await getCommitDetail(REPO, RAW_COMMIT.sha);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].filename).toBe('src/widget.ts');
    expect(result.files[0].patch).toContain('-old');
    expect(result.stats.total).toBe(7);
  });

  it('throws GitHubApiError with the HTTP status', async () => {
    globalThis.fetch = stubFetch({ message: 'rate limited' }, 403) as unknown as typeof fetch;
    const err = await getCommitDetail(REPO, 'sha').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).status).toBe(403);
  });
});

// ── listPulls ──────────────────────────────────────────────────────────────

const RAW_PR = {
  number: 7,
  title: 'feat: add widget',
  state: 'open',
  merged_at: null as string | null,
  draft: false,
  user: { login: 'octocat' },
  head: { ref: 'feat/widget', sha: 'abc1234' },
  base: { ref: 'main' },
  labels: [{ name: 'enhancement' }],
  comments: 3,
  created_at: '2026-05-30T10:00:00Z',
  updated_at: '2026-05-31T08:00:00Z',
  html_url: 'https://github.com/acme/widget/pull/7',
};

const MERGED_PR = {
  ...RAW_PR,
  number: 6,
  state: 'closed',
  merged_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
};

const OLD_PR = {
  ...RAW_PR,
  number: 5,
  state: 'closed',
  merged_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago — outside window
};

describe('listPulls', () => {
  let saved: FetchLike;
  beforeEach(() => { saved = globalThis.fetch as unknown as FetchLike; });
  afterEach(() => { globalThis.fetch = saved as unknown as typeof fetch; });

  it('maps open PRs to GitHubPR shape', async () => {
    globalThis.fetch = stubFetchSequence([RAW_PR], []) as unknown as typeof fetch;

    const { open, recentlyMerged } = await listPulls(REPO);
    expect(open).toHaveLength(1);
    expect(recentlyMerged).toHaveLength(0);
    const pr = open[0];
    expect(pr.number).toBe(7);
    expect(pr.title).toBe('feat: add widget');
    expect(pr.state).toBe('open');
    expect(pr.merged).toBe(false);
    expect(pr.mergedAt).toBeNull();
    expect(pr.draft).toBe(false);
    expect(pr.author).toBe('octocat');
    expect(pr.headBranch).toBe('feat/widget');
    expect(pr.baseBranch).toBe('main');
    expect(pr.labels).toEqual(['enhancement']);
    expect(pr.commentCount).toBe(3);
    expect(pr.url).toBe('https://github.com/acme/widget/pull/7');
  });

  it('includes merged PRs within 7-day window, excludes older ones', async () => {
    globalThis.fetch = stubFetchSequence([], [MERGED_PR, OLD_PR]) as unknown as typeof fetch;

    const { open, recentlyMerged } = await listPulls(REPO);
    expect(open).toHaveLength(0);
    expect(recentlyMerged).toHaveLength(1);
    expect(recentlyMerged[0].number).toBe(6);
    expect(recentlyMerged[0].merged).toBe(true);
  });

  it('throws GitHubApiError on non-2xx', async () => {
    globalThis.fetch = stubFetch({ message: 'Not Found' }, 404) as unknown as typeof fetch;
    await expect(listPulls(REPO)).rejects.toBeInstanceOf(GitHubApiError);
  });

  it('paginates closed PRs and includes a merged PR beyond the first page', async () => {
    const now = new Date().toISOString();
    const recentUnmerged = { ...RAW_PR, number: 8, state: 'closed', merged_at: null as string | null, updated_at: now };
    const recentMerged = { ...RAW_PR, number: 9, state: 'closed', merged_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), updated_at: now };
    // open=[], closed p1=[recentUnmerged] (oldest updated_at >= cutoff → keep going), p2=[recentMerged], p3=[] (stop).
    globalThis.fetch = stubFetchSequence([], [recentUnmerged], [recentMerged], []) as unknown as typeof fetch;

    const { recentlyMerged } = await listPulls(REPO);
    expect(recentlyMerged.map((p) => p.number)).toContain(9); // not dropped by the 100-row first page
  });
});

// ── getPullReviews ─────────────────────────────────────────────────────────

describe('getPullReviews', () => {
  let saved: FetchLike;
  beforeEach(() => { saved = globalThis.fetch as unknown as FetchLike; });
  afterEach(() => { globalThis.fetch = saved as unknown as typeof fetch; });

  it('maps review response to GitHubPRReview[]', async () => {
    const raw = [{
      id: 101,
      user: { login: 'alice' },
      state: 'APPROVED',
      body: 'LGTM',
      submitted_at: '2026-05-31T09:00:00Z',
    }];
    globalThis.fetch = stubFetch(raw) as unknown as typeof fetch;
    const reviews = await getPullReviews(REPO, 7);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].id).toBe(101);
    expect(reviews[0].author).toBe('alice');
    expect(reviews[0].state).toBe('APPROVED');
    expect(reviews[0].body).toBe('LGTM');
    expect(reviews[0].submittedAt).toBe('2026-05-31T09:00:00Z');
  });
});

// ── getPullChecks ──────────────────────────────────────────────────────────

describe('getPullChecks', () => {
  let saved: FetchLike;
  beforeEach(() => { saved = globalThis.fetch as unknown as FetchLike; });
  afterEach(() => { globalThis.fetch = saved as unknown as typeof fetch; });

  it('maps check-run response to GitHubCheckRun[]', async () => {
    const raw = {
      check_runs: [{
        name: 'CI',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/acme/widget/actions/runs/1',
      }],
    };
    globalThis.fetch = stubFetch(raw) as unknown as typeof fetch;
    const checks = await getPullChecks(REPO, 'abc1234');
    expect(checks).toHaveLength(1);
    expect(checks[0].name).toBe('CI');
    expect(checks[0].status).toBe('completed');
    expect(checks[0].conclusion).toBe('success');
    expect(checks[0].url).toBe('https://github.com/acme/widget/actions/runs/1');
  });

  it('returns empty array when no check runs', async () => {
    globalThis.fetch = stubFetch({ check_runs: [] }) as unknown as typeof fetch;
    const checks = await getPullChecks(REPO, 'abc1234');
    expect(checks).toHaveLength(0);
  });
});

// ── getPull ────────────────────────────────────────────────────────────────

describe('getPull', () => {
  let saved: FetchLike;
  beforeEach(() => { saved = globalThis.fetch as unknown as FetchLike; });
  afterEach(() => { globalThis.fetch = saved as unknown as typeof fetch; });

  it('returns GitHubPRDetail with file stats, reviews, and checks', async () => {
    const rawDetail = {
      ...RAW_PR,
      additions: 120,
      deletions: 45,
      changed_files: 8,
    };
    globalThis.fetch = stubFetchSequence(rawDetail, [], { check_runs: [] }) as unknown as typeof fetch;

    const detail = await getPull(REPO, 7);
    expect(detail.number).toBe(7);
    expect(detail.additions).toBe(120);
    expect(detail.deletions).toBe(45);
    expect(detail.changedFiles).toBe(8);
    expect(detail.reviews).toEqual([]);
    expect(detail.checkRuns).toEqual([]);
    expect(detail.reviewDecision).toBeNull();
    expect(detail.ciStatus).toBeNull();
  });

  it('derives APPROVED reviewDecision when latest review per reviewer is APPROVED', async () => {
    const rawDetail = { ...RAW_PR, additions: 0, deletions: 0, changed_files: 0 };
    const reviews = [
      { id: 1, user: { login: 'alice' }, state: 'APPROVED', body: '', submitted_at: '2026-05-31T09:00:00Z' },
    ];
    globalThis.fetch = stubFetchSequence(rawDetail, reviews, { check_runs: [] }) as unknown as typeof fetch;

    const detail = await getPull(REPO, 7);
    expect(detail.reviewDecision).toBe('APPROVED');
  });

  it('derives CHANGES_REQUESTED when any reviewer requested changes', async () => {
    const rawDetail = { ...RAW_PR, additions: 0, deletions: 0, changed_files: 0 };
    const reviews = [
      { id: 1, user: { login: 'alice' }, state: 'APPROVED', body: '', submitted_at: '2026-05-31T09:00:00Z' },
      { id: 2, user: { login: 'bob' }, state: 'CHANGES_REQUESTED', body: 'fix this', submitted_at: '2026-05-31T10:00:00Z' },
    ];
    globalThis.fetch = stubFetchSequence(rawDetail, reviews, { check_runs: [] }) as unknown as typeof fetch;

    const detail = await getPull(REPO, 7);
    expect(detail.reviewDecision).toBe('CHANGES_REQUESTED');
  });

  it('derives ciStatus: failure when any check fails', async () => {
    const rawDetail = { ...RAW_PR, additions: 0, deletions: 0, changed_files: 0 };
    const checks = {
      check_runs: [
        { name: 'CI', status: 'completed', conclusion: 'failure', html_url: 'https://github.com' },
      ],
    };
    globalThis.fetch = stubFetchSequence(rawDetail, [], checks) as unknown as typeof fetch;

    const detail = await getPull(REPO, 7);
    expect(detail.ciStatus).toBe('failure');
  });

  it('derives ciStatus: failure for cancelled/action_required (not masked as success)', async () => {
    const rawDetail = { ...RAW_PR, additions: 0, deletions: 0, changed_files: 0 };
    const checks = {
      check_runs: [
        { name: 'A', status: 'completed', conclusion: 'success', html_url: 'https://github.com' },
        { name: 'B', status: 'completed', conclusion: 'cancelled', html_url: 'https://github.com' },
      ],
    };
    globalThis.fetch = stubFetchSequence(rawDetail, [], checks) as unknown as typeof fetch;

    const detail = await getPull(REPO, 7);
    expect(detail.ciStatus).toBe('failure'); // a cancelled check is non-passing — was wrongly 'success'
  });
});

// ── createReview ───────────────────────────────────────────────────────────

describe('createReview', () => {
  let saved: FetchLike;
  beforeEach(() => { saved = globalThis.fetch as unknown as FetchLike; });
  afterEach(() => { globalThis.fetch = saved as unknown as typeof fetch; });

  it('POSTs APPROVE event without body', async () => {
    const spy = stubFetch({ id: 200, state: 'APPROVED' });
    globalThis.fetch = spy as unknown as typeof fetch;
    await createReview(REPO, 7, { event: 'APPROVE' });
    const [url, init] = (spy as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/pulls/7/reviews');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.event).toBe('APPROVE');
    expect(sent.body).toBeUndefined();
  });

  it('POSTs REQUEST_CHANGES event with body text', async () => {
    const spy = stubFetch({ id: 201, state: 'CHANGES_REQUESTED' });
    globalThis.fetch = spy as unknown as typeof fetch;
    await createReview(REPO, 7, { event: 'REQUEST_CHANGES', body: 'Please fix the tests.' });
    const [, init] = (spy as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.event).toBe('REQUEST_CHANGES');
    expect(sent.body).toBe('Please fix the tests.');
  });

  it('throws GitHubApiError on non-2xx', async () => {
    globalThis.fetch = stubFetch({ message: 'Forbidden' }, 403) as unknown as typeof fetch;
    await expect(createReview(REPO, 7, { event: 'APPROVE' })).rejects.toBeInstanceOf(GitHubApiError);
  });
});

// ── closePull ──────────────────────────────────────────────────────────────

describe('closePull', () => {
  let saved: FetchLike;
  beforeEach(() => { saved = globalThis.fetch as unknown as FetchLike; });
  afterEach(() => { globalThis.fetch = saved as unknown as typeof fetch; });

  it('PATCHes with state: closed', async () => {
    const spy = stubFetch({ number: 7, state: 'closed' });
    globalThis.fetch = spy as unknown as typeof fetch;
    await closePull(REPO, 7);
    const [url, init] = (spy as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/pulls/7');
    expect(init.method).toBe('PATCH');
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.state).toBe('closed');
  });

  it('throws GitHubApiError on non-2xx', async () => {
    globalThis.fetch = stubFetch({ message: 'Forbidden' }, 403) as unknown as typeof fetch;
    await expect(closePull(REPO, 7)).rejects.toBeInstanceOf(GitHubApiError);
  });
});

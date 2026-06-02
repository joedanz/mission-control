// ABOUTME: Unit tests for lib/sentry-api — mocks globalThis.fetch; no network calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listUnresolvedIssues } from '../lib/sentry-api';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function stubResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const REF = { org: 'acme', project: 'web' };

const RAW_ISSUE = {
  id: '123',
  shortId: 'WEB-1',
  title: 'TypeError: undefined is not a function',
  culprit: 'app/page.tsx in render',
  level: 'error',
  count: '1204',
  userCount: 89,
  lastSeen: '2026-06-02T10:00:00Z',
  permalink: 'https://acme.sentry.io/issues/123/',
};

describe('listUnresolvedIssues', () => {
  let savedFetch: FetchLike;
  const savedToken = process.env.SENTRY_AUTH_TOKEN;
  const savedBase = process.env.SENTRY_BASE_URL;

  beforeEach(() => {
    savedFetch = globalThis.fetch as FetchLike;
    process.env.SENTRY_AUTH_TOKEN = 'tok_test';
    delete process.env.SENTRY_BASE_URL;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.SENTRY_AUTH_TOKEN; else process.env.SENTRY_AUTH_TOKEN = savedToken;
    if (savedBase === undefined) delete process.env.SENTRY_BASE_URL; else process.env.SENTRY_BASE_URL = savedBase;
  });

  it('calls the right URL with the bearer token and maps issues', async () => {
    const spy = vi.fn().mockResolvedValue(stubResponse([RAW_ISSUE]));
    globalThis.fetch = spy as unknown as typeof fetch;

    const issues = await listUnresolvedIssues(REF, { statsPeriod: '24h', limit: 25 });

    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe(
      'https://sentry.io/api/0/projects/acme/web/issues/?query=is%3Aunresolved&statsPeriod=24h&limit=25',
    );
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok_test');
    expect(issues).toEqual([{
      id: '123',
      shortId: 'WEB-1',
      title: 'TypeError: undefined is not a function',
      culprit: 'app/page.tsx in render',
      level: 'error',
      count: 1204,
      userCount: 89,
      lastSeen: '2026-06-02T10:00:00Z',
      permalink: 'https://acme.sentry.io/issues/123/',
    }]);
  });

  it('throws SentryApiError with status on non-2xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(stubResponse({ detail: 'nope' }, 403)) as unknown as typeof fetch;
    await expect(listUnresolvedIssues(REF)).rejects.toMatchObject({ name: 'SentryApiError', status: 403 });
  });
});

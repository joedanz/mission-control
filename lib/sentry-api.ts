// ABOUTME: Sentry REST client for the web UI — fetches a project's unresolved issues via SENTRY_AUTH_TOKEN.
// ABOUTME: Uses fetch (no SDK), so it works on Vercel. Mirrors lib/github-api.ts.

import type { SentryRef } from './sentry';

export type SentryIssue = {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string; // error | warning | info | fatal | debug | sample
  count: number; // event count in the window (Sentry returns a string)
  userCount: number;
  lastSeen: string; // ISO
  permalink: string;
};

export type ErrorsSummary = { unresolvedShown: number; events24h: number; window: '24h' };

export class SentryApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'SentryApiError';
  }
}

function sentryBase(): string {
  return process.env.SENTRY_BASE_URL || 'https://sentry.io';
}

async function sentryFetch(path: string): Promise<unknown> {
  const res = await fetch(`${sentryBase()}${path}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${process.env.SENTRY_AUTH_TOKEN}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SentryApiError(`Sentry API ${res.status}: ${body.slice(0, 200)}`, res.status);
  }
  return res.json();
}

type RawIssue = {
  id: string;
  shortId: string;
  title: string;
  culprit: string | null;
  level: string;
  count: string;
  userCount: number;
  lastSeen: string;
  permalink: string;
};

export async function listUnresolvedIssues(
  ref: SentryRef,
  opts: { statsPeriod?: string; limit?: number } = {},
): Promise<SentryIssue[]> {
  const qs = new URLSearchParams({
    query: 'is:unresolved',
    statsPeriod: opts.statsPeriod ?? '24h',
    limit: String(opts.limit ?? 25),
  });
  const data = (await sentryFetch(
    `/api/0/projects/${ref.org}/${ref.project}/issues/?${qs.toString()}`,
  )) as RawIssue[];

  return data.map((i) => ({
    id: i.id,
    shortId: i.shortId,
    title: i.title,
    culprit: i.culprit ?? '',
    level: i.level,
    count: Number(i.count) || 0,
    userCount: i.userCount,
    lastSeen: i.lastSeen,
    permalink: i.permalink,
  }));
}

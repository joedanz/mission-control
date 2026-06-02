// ABOUTME: Maps a project (sentryProjectSlug) + SENTRY_ORG env to a Sentry API ref. The parseGitHubRepo analog.

export type SentryRef = { org: string; project: string };

/** A project's Sentry ref, or null when unmapped (no slug, or no SENTRY_ORG configured). */
export function sentryProjectRef(p: { sentryProjectSlug: string | null }): SentryRef | null {
  const org = process.env.SENTRY_ORG;
  if (!org || !p.sentryProjectSlug) return null;
  return { org, project: p.sentryProjectSlug };
}

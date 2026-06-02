// ABOUTME: GET unresolved Sentry issues for a project. Auth-gated; requires SENTRY_ORG + SENTRY_AUTH_TOKEN.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getProjectBySlug } from '@/lib/queries';
import { sentryProjectRef } from '@/lib/sentry';
import { listUnresolvedIssues, SentryApiError, type ErrorsSummary } from '@/lib/sentry-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    await requireAllowedUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    throw e;
  }

  const { slug } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });

  const ref = sentryProjectRef(project);
  if (!ref) {
    return Response.json({ ok: false, error: 'no_sentry_project' }, { status: 422 });
  }

  if (!process.env.SENTRY_AUTH_TOKEN) {
    return Response.json({ ok: false, error: 'sentry_token_missing' }, { status: 503 });
  }

  try {
    const issues = await listUnresolvedIssues(ref, { statsPeriod: '24h', limit: 25 });
    const summary: ErrorsSummary = {
      unresolvedShown: issues.length,
      events24h: issues.reduce((n, i) => n + i.count, 0),
      window: '24h',
    };
    return Response.json({ ok: true, data: { issues, summary } });
  } catch (e) {
    if (e instanceof SentryApiError) {
      return Response.json(
        { ok: false, error: 'sentry_api_error', message: e.message },
        { status: e.status ?? 502 },
      );
    }
    throw e;
  }
}

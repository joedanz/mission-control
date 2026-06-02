// ABOUTME: POST approve or request-changes on a PR. Requires Pull requests: Write on GITHUB_TOKEN.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getProjectBySlug } from '@/lib/queries';
import { parseGitHubRepo } from '@/lib/github';
import { createReview, GitHubApiError } from '@/lib/github-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string; number: string }> },
): Promise<Response> {
  try {
    await requireAllowedUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    throw e;
  }

  const { slug, number: numberStr } = await params;
  const prNumber = parseInt(numberStr, 10);
  if (Number.isNaN(prNumber)) {
    return Response.json({ ok: false, error: 'invalid_pr_number' }, { status: 400 });
  }

  const rawBody = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = typeof rawBody?.action === 'string' ? rawBody.action : null;
  if (!action || !['approve', 'request_changes'].includes(action)) {
    return Response.json(
      { ok: false, error: 'invalid_body', message: 'action must be "approve" or "request_changes"' },
      { status: 400 },
    );
  }
  const bodyText = typeof rawBody?.body === 'string' ? rawBody.body : undefined;
  if (action === 'request_changes' && !bodyText?.trim()) {
    return Response.json(
      { ok: false, error: 'body_required', message: 'body is required for request_changes' },
      { status: 400 },
    );
  }

  const project = await getProjectBySlug(slug);
  if (!project) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });

  const githubRepo = parseGitHubRepo(project.repoUrl);
  if (!githubRepo) {
    return Response.json({ ok: false, error: 'no_github_repo' }, { status: 422 });
  }

  if (!process.env.GITHUB_TOKEN) {
    return Response.json({ ok: false, error: 'github_token_missing' }, { status: 503 });
  }

  try {
    await createReview(githubRepo, prNumber, {
      event: action === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES',
      body: bodyText,
    });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof GitHubApiError) {
      return Response.json(
        { ok: false, error: 'github_api_error', message: e.message },
        { status: e.status ?? 502 },
      );
    }
    throw e;
  }
}

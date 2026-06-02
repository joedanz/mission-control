// ABOUTME: GET open + recently-merged PRs for a project's GitHub repo.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getProjectBySlug } from '@/lib/queries';
import { parseGitHubRepo } from '@/lib/github';
import { listPulls, GitHubApiError } from '@/lib/github-api';

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

  const githubRepo = parseGitHubRepo(project.repoUrl);
  if (!githubRepo) {
    return Response.json({ ok: false, error: 'no_github_repo' }, { status: 422 });
  }

  if (!process.env.GITHUB_TOKEN) {
    return Response.json({ ok: false, error: 'github_token_missing' }, { status: 503 });
  }

  try {
    const { open, recentlyMerged } = await listPulls(githubRepo);
    return Response.json({ ok: true, data: { open, recentlyMerged } });
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

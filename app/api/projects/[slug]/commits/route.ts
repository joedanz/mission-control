// ABOUTME: GET recent commits for a project's GitHub repo. Auth-gated; requires GITHUB_TOKEN.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getProjectBySlug } from '@/lib/queries';
import { parseGitHubRepo } from '@/lib/github';
import { listCommits, GitHubApiError } from '@/lib/github-api';

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
    const commits = await listCommits(githubRepo, { perPage: 20 });
    return Response.json({ ok: true, data: { commits } });
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

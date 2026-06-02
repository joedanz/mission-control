// ABOUTME: GET email-DNS verification for a project's domain. Auth-gated; no external token (DNS only).

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getProjectBySlug } from '@/lib/queries';
import { checkEmailDns } from '@/lib/email-dns';

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

  if (!project.domain) {
    return Response.json({ ok: false, error: 'no_domain' }, { status: 422 });
  }

  try {
    const checks = await checkEmailDns(project.domain);
    return Response.json({
      ok: true,
      data: {
        domain: project.domain,
        checks,
        detectedProvider: checks.detectedProvider,
        manual: { provider: project.emailProvider, address: project.emailAddress },
      },
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: 'email_dns_error', message: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

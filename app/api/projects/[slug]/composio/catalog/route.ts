// ABOUTME: MCP catalog browse for a project — GET lists Composio's live toolkit catalog (search/limit)
// ABOUTME: with featured (curated) + connected (this project already has an active row) flags.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { listToolkits, ComposioApiError } from '@/lib/composio-api';
import { listConnections } from '@/lib/composio-connections';
import { COMPOSIO_CATALOG } from '@/lib/composio-catalog';
import { NotFoundError } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  try {
    await requireAllowedUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    throw e;
  }
  const { slug } = await params;
  const url = new URL(req.url);
  const search = url.searchParams.get('search') || undefined;
  const limitRaw = url.searchParams.get('limit');
  const limitNum = limitRaw !== null ? Number(limitRaw) : NaN;
  const limit = Number.isFinite(limitNum) && limitNum > 0 ? limitNum : undefined;
  try {
    const [toolkits, connections] = await Promise.all([listToolkits({ search, limit }), listConnections(slug)]);
    const connected = new Set(
      connections.filter((c) => c.source === 'composio' && c.status === 'active' && c.toolkitSlug).map((c) => c.toolkitSlug),
    );
    return Response.json({
      ok: true,
      data: {
        toolkits: toolkits.map((t) => ({ ...t, featured: Object.hasOwn(COMPOSIO_CATALOG, t.slug), connected: connected.has(t.slug) })),
      },
    });
  } catch (e) {
    if (e instanceof NotFoundError) {
      return Response.json({ ok: false, error: 'not_found', message: e.message }, { status: 404 });
    }
    if (e instanceof ComposioApiError) {
      return Response.json({ ok: false, error: 'composio_api_error', message: e.message }, { status: e.status ?? 502 });
    }
    throw e;
  }
}

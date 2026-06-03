// ABOUTME: Composio integrations for a project. GET lists the catalog overlaid with this project's
// ABOUTME: connection statuses; POST drives connect/status/disconnect over the slice-2 lifecycle.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { listConnections, connectStart, connectPoll, disconnect } from '@/lib/composio-connections';
import { toolkitViews } from '@/lib/composio-view';
import { NotFoundError, ValidationError } from '@/lib/validation';
import { ComposioApiError } from '@/lib/composio-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Returns a 401 Response if the caller isn't allowed, else null. Rethrows non-auth errors. */
async function gate(): Promise<Response | null> {
  try {
    await requireAllowedUser();
    return null;
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    throw e;
  }
}

/** Map a lifecycle error to the right Response; rethrow anything unrecognized (→ Next 500). */
function mapError(e: unknown): Response {
  if (e instanceof NotFoundError) {
    return Response.json({ ok: false, error: 'not_found', message: e.message }, { status: 404 });
  }
  if (e instanceof ValidationError) {
    return Response.json({ ok: false, error: 'validation', message: e.message }, { status: 422 });
  }
  if (e instanceof ComposioApiError) {
    return Response.json({ ok: false, error: 'composio_api_error', message: e.message }, { status: e.status ?? 502 });
  }
  throw e;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const denied = await gate();
  if (denied) return denied;
  const { slug } = await params;
  try {
    const connections = await listConnections(slug);
    return Response.json({ ok: true, data: { toolkits: toolkitViews(connections) } });
  } catch (e) {
    return mapError(e);
  }
}

type PostBody = { action?: string; toolkit?: string };

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const denied = await gate();
  if (denied) return denied;
  const { slug } = await params;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return Response.json({ ok: false, error: 'validation', message: 'invalid JSON body' }, { status: 422 });
  }
  const { action, toolkit } = body;
  if (!toolkit) {
    return Response.json({ ok: false, error: 'validation', message: 'toolkit required' }, { status: 422 });
  }

  try {
    switch (action) {
      case 'connect': {
        const { linkUrl, connection } = await connectStart(slug, toolkit);
        return Response.json({ ok: true, data: { linkUrl, status: connection.status } });
      }
      case 'status': {
        const connection = await connectPoll(slug, toolkit);
        return Response.json({ ok: true, data: { status: connection.status } });
      }
      case 'disconnect': {
        const connection = await disconnect(slug, toolkit);
        return Response.json({ ok: true, data: { status: connection.status } });
      }
      default:
        return Response.json(
          { ok: false, error: 'validation', message: `unknown action: ${String(action)}` },
          { status: 422 },
        );
    }
  } catch (e) {
    return mapError(e);
  }
}

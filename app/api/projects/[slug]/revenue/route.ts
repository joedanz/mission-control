// ABOUTME: GET a project's active Stripe subscriptions + computed MRR. Auth-gated; requires STRIPE_SECRET_KEY.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getProjectBySlug } from '@/lib/queries';
import { stripeSiteRef } from '@/lib/stripe';
import {
  listActiveSubscriptions,
  computeMrr,
  StripeApiError,
  type RevenueSummary,
} from '@/lib/stripe-api';

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

  const ref = stripeSiteRef(project);
  if (!ref) {
    return Response.json({ ok: false, error: 'no_stripe_site' }, { status: 422 });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return Response.json({ ok: false, error: 'stripe_token_missing' }, { status: 503 });
  }

  try {
    const { subscriptions, truncated } = await listActiveSubscriptions(ref);
    const summary: RevenueSummary = {
      activeCount: subscriptions.length,
      mrrByCurrency: computeMrr(subscriptions),
      truncated,
    };
    return Response.json({ ok: true, data: { site: ref.site, subscriptions, summary } });
  } catch (e) {
    if (e instanceof StripeApiError) {
      return Response.json(
        { ok: false, error: 'stripe_api_error', message: e.message },
        { status: e.status ?? 502 },
      );
    }
    throw e;
  }
}

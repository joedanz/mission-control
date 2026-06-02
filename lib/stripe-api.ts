// ABOUTME: Stripe REST client for the web UI — lists a site's active subscriptions via STRIPE_SECRET_KEY.
// ABOUTME: Uses fetch (no SDK), so it works on Vercel. Mirrors lib/sentry-api.ts. Segments by metadata.site.

import type { StripeSiteRef } from './stripe';

const STRIPE_BASE = 'https://api.stripe.com';
const SEARCH_PAGE_LIMIT = 100;
const MAX_PAGES = 10; // up to 1000 active subs; beyond this we report `truncated`

/** Stripe's zero-decimal currencies — amounts are already in the major unit (no /100 for display). */
export const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

export type StripeSubscription = {
  id: string;
  customerName: string | null;
  customerEmail: string | null;
  status: string;
  amountMinor: number;
  currency: string;
  interval: string;
  intervalCount: number;
  quantity: number;
  monthlyMinor: number;
  created: number;
};

export type RevenueSummary = {
  activeCount: number;
  mrrByCurrency: Record<string, number>;
  truncated: boolean;
};

export class StripeApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'StripeApiError';
  }
}

async function stripeFetch(path: string): Promise<unknown> {
  const res = await fetch(`${STRIPE_BASE}${path}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new StripeApiError(`Stripe API ${res.status}: ${body.slice(0, 200)}`, res.status);
  }
  return res.json();
}

/** Normalize a per-period amount (minor units) to a monthly figure. Unknown interval → 0. */
export function normalizeToMonthly(amountMinor: number, interval: string, intervalCount: number): number {
  const n = intervalCount < 1 ? 1 : intervalCount;
  switch (interval) {
    case 'month':
      return Math.round(amountMinor / n);
    case 'year':
      return Math.round(amountMinor / (12 * n));
    case 'week':
      return Math.round((amountMinor * 52) / 12 / n);
    case 'day':
      return Math.round((amountMinor * 365) / 12 / n);
    default:
      return 0;
  }
}

/** Sum each subscription's monthly contribution into a per-currency MRR map. */
export function computeMrr(subs: StripeSubscription[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of subs) {
    out[s.currency] = (out[s.currency] ?? 0) + s.monthlyMinor;
  }
  return out;
}

type RawSub = {
  id: string;
  status: string;
  created: number;
  customer: string | { id: string; name?: string | null; email?: string | null };
  items: {
    data: Array<{
      quantity?: number;
      price?: {
        unit_amount?: number | null;
        currency?: string;
        recurring?: { interval?: string; interval_count?: number };
      };
    }>;
  };
};

function mapSub(raw: RawSub): StripeSubscription {
  const item = raw.items?.data?.[0];
  const price = item?.price;
  const unitAmount = price?.unit_amount ?? 0;
  const quantity = item?.quantity ?? 1;
  const currency = price?.currency ?? 'usd';
  const interval = price?.recurring?.interval ?? '';
  const intervalCount = price?.recurring?.interval_count ?? 1;
  const amountMinor = unitAmount * quantity;
  const customer = raw.customer;
  const isObj = typeof customer === 'object' && customer !== null;
  return {
    id: raw.id,
    customerName: isObj ? customer.name ?? null : null,
    customerEmail: isObj ? customer.email ?? null : null,
    status: raw.status,
    amountMinor,
    currency,
    interval,
    intervalCount,
    quantity,
    monthlyMinor: normalizeToMonthly(amountMinor, interval, intervalCount),
    created: raw.created,
  };
}

type SearchPage = { data: RawSub[]; has_more?: boolean; next_page?: string | null };

/**
 * List a site's active subscriptions via Stripe's Search API, paginating to MAX_PAGES.
 * Segments by metadata.site. Returns `truncated:true` if more pages remained past the cap.
 */
export async function listActiveSubscriptions(
  ref: StripeSiteRef,
): Promise<{ subscriptions: StripeSubscription[]; truncated: boolean }> {
  if (ref.site.includes("'")) {
    throw new StripeApiError(`Invalid stripeSite (contains a quote): ${ref.site}`);
  }

  const subscriptions: StripeSubscription[] = [];
  let page: string | null = null;
  let pages = 0;
  let hasMore = false;

  do {
    const qs = new URLSearchParams({
      query: `metadata['site']:'${ref.site}' AND status:'active'`,
      limit: String(SEARCH_PAGE_LIMIT),
    });
    qs.append('expand[]', 'data.customer');
    if (page) qs.set('page', page);

    const res = (await stripeFetch(`/v1/subscriptions/search?${qs.toString()}`)) as SearchPage;
    for (const raw of res.data ?? []) subscriptions.push(mapSub(raw));

    hasMore = Boolean(res.has_more);
    page = res.next_page ?? null;
    pages += 1;
  } while (hasMore && page && pages < MAX_PAGES);

  return { subscriptions, truncated: hasMore };
}

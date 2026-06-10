// ABOUTME: Unit tests for lib/stripe-api — mocks globalThis.fetch; no network calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  listActiveSubscriptions,
  normalizeToMonthly,
  computeMrr,
  StripeApiError,
  type StripeSubscription,
} from '../lib/stripe-api';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function stubResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function rawSub(over: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    status: 'active',
    created: 1_700_000_000,
    customer: { id: 'cus_1', name: 'Jane Cooper', email: 'jane@example.com' },
    items: {
      data: [
        {
          quantity: 1,
          price: {
            unit_amount: 1200,
            currency: 'usd',
            recurring: { interval: 'month', interval_count: 1 },
          },
        },
      ],
    },
    ...over,
  };
}

const REF = { site: 'memoiries' };

describe('listActiveSubscriptions', () => {
  let savedFetch: FetchLike;
  const savedKey = process.env.STRIPE_SECRET_KEY;

  beforeEach(() => {
    savedFetch = globalThis.fetch as FetchLike;
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedKey;
  });

  it('builds the search URL with the site filter + bearer header and maps a subscription', async () => {
    const spy = vi.fn().mockResolvedValue(stubResponse({ data: [rawSub()], has_more: false }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { subscriptions, truncated } = await listActiveSubscriptions(REF);

    const [url, init] = spy.mock.calls[0];
    const u = new URL(String(url));
    expect(u.origin + u.pathname).toBe('https://api.stripe.com/v1/subscriptions/search');
    expect(u.searchParams.get('query')).toBe("metadata['site']:'memoiries' AND status:'active'");
    expect(u.searchParams.get('limit')).toBe('100');
    expect(u.searchParams.getAll('expand[]')).toContain('data.customer');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_123');

    expect(truncated).toBe(false);
    expect(subscriptions).toEqual<StripeSubscription[]>([
      {
        id: 'sub_1',
        customerName: 'Jane Cooper',
        customerEmail: 'jane@example.com',
        status: 'active',
        amountMinor: 1200,
        currency: 'usd',
        interval: 'month',
        intervalCount: 1,
        quantity: 1,
        monthlyMinor: 1200,
        metered: false,
        created: 1_700_000_000,
      },
    ]);
  });

  it('treats a bare-id customer as null name/email', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(stubResponse({ data: [rawSub({ customer: 'cus_bare' })], has_more: false })) as unknown as typeof fetch;
    const { subscriptions } = await listActiveSubscriptions(REF);
    expect(subscriptions[0].customerName).toBeNull();
    expect(subscriptions[0].customerEmail).toBeNull();
  });

  it('paginates: follows next_page and concatenates results', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(stubResponse({ data: [rawSub({ id: 'sub_1' })], has_more: true, next_page: 'PAGE2' }))
      .mockResolvedValueOnce(stubResponse({ data: [rawSub({ id: 'sub_2' })], has_more: false }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { subscriptions, truncated } = await listActiveSubscriptions(REF);

    expect(spy).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(String(spy.mock.calls[1][0]));
    expect(secondUrl.searchParams.get('page')).toBe('PAGE2');
    expect(subscriptions.map((s) => s.id)).toEqual(['sub_1', 'sub_2']);
    expect(truncated).toBe(false);
  });

  it('sets truncated when has_more persists past the page cap', async () => {
    const spy = vi.fn().mockResolvedValue(stubResponse({ data: [rawSub()], has_more: true, next_page: 'MORE' }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { truncated } = await listActiveSubscriptions(REF);

    expect(spy).toHaveBeenCalledTimes(10);
    expect(truncated).toBe(true);
  });

  it('rejects a site containing a single quote (query-injection guard)', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    await expect(listActiveSubscriptions({ site: "x' OR '1" })).rejects.toBeInstanceOf(StripeApiError);
  });

  it('throws StripeApiError with status on a non-2xx response', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(stubResponse({ error: { message: 'nope' } }, 401)) as unknown as typeof fetch;
    await expect(listActiveSubscriptions(REF)).rejects.toMatchObject({ name: 'StripeApiError', status: 401 });
  });
});

describe('normalizeToMonthly', () => {
  it('month divides by intervalCount', () => {
    expect(normalizeToMonthly(1200, 'month', 1)).toBe(1200);
    expect(normalizeToMonthly(1200, 'month', 3)).toBe(400);
  });
  it('year divides by 12 * intervalCount', () => {
    expect(normalizeToMonthly(12000, 'year', 1)).toBe(1000);
    expect(normalizeToMonthly(24000, 'year', 2)).toBe(1000);
  });
  it('week scales by 52/12', () => {
    expect(normalizeToMonthly(1200, 'week', 1)).toBe(Math.round((1200 * 52) / 12));
  });
  it('day scales by 365/12', () => {
    expect(normalizeToMonthly(120, 'day', 1)).toBe(Math.round((120 * 365) / 12));
  });
  it('unknown interval yields 0', () => {
    expect(normalizeToMonthly(1200, 'fortnight', 1)).toBe(0);
  });
  it('treats intervalCount < 1 as 1', () => {
    expect(normalizeToMonthly(1200, 'month', 0)).toBe(1200);
  });
});

describe('computeMrr', () => {
  it('sums monthlyMinor per currency, never across currencies', () => {
    const subs = [
      { monthlyMinor: 1200, currency: 'usd' },
      { monthlyMinor: 800, currency: 'usd' },
      { monthlyMinor: 500, currency: 'eur' },
    ] as StripeSubscription[];
    expect(computeMrr(subs)).toEqual({ usd: 2000, eur: 500 });
  });

  it('excludes metered subscriptions (no fixed unit price) instead of counting them as $0', () => {
    const subs = [
      { monthlyMinor: 1200, currency: 'usd', metered: false },
      { monthlyMinor: 0, currency: 'usd', metered: true }, // metered/tiered — amount lives in tiers
    ] as StripeSubscription[];
    expect(computeMrr(subs)).toEqual({ usd: 1200 });
  });
});

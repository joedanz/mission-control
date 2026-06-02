# Revenue (Stripe) Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only **Revenue** tab to the project detail page showing a Stripe site's computed MRR and active subscriptions, visible only for projects mapped via a new `stripeSite` field.

**Architecture:** Direct mirror of the Errors (Sentry) slice. `lib/stripe.ts` (mapping helper) → `lib/stripe-api.ts` (fetch-based REST client, no SDK) → `app/api/projects/[slug]/revenue/route.ts` → `'use client'` `RevenueTab` → conditional tab in `app/p/[slug]/page.tsx`. Single `STRIPE_SECRET_KEY` (one Stripe account); per-project segmentation is the `metadata.site` filter against Stripe's Search API. MRR is computed client-of-API-side by normalizing each active subscription's price to monthly, summed per currency.

**Tech Stack:** Next.js 16 App Router (RSC + client islands), Drizzle ORM + Neon Postgres, Vitest (node env, real Neon DB), commander CLI (`mc`), Stripe REST Search API via `fetch`.

**Spec:** `docs/superpowers/specs/2026-06-02-stripe-revenue-tab-design.md`

**Git note for the implementer:** You are on branch `feat/stripe-revenue-tab`. NEVER run `git add -A`, `git stash`, `git reset`, `git checkout`, `git restore`, or `git clean`. Stage only the explicit files named in each task's commit step. A stash may hold unrelated work — never touch it.

**Lint note:** A full `npm run lint` can crash (RangeError) on gitignored build artifacts under `docs/`. For lint verification use the scoped form: `npx eslint lib components app cli test`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `lib/db/schema.ts` | add `stripeSite` column to `projects` |
| `migrations/NNNN_*.sql` | drizzle-generated `ADD COLUMN stripe_site` |
| `lib/mutations.ts` | `stripeSite` in `ProjectInput` + create/update wiring |
| `lib/stripe.ts` | `stripeSiteRef` mapping helper (project → site ref) |
| `lib/stripe-api.ts` | Stripe REST client: `stripeFetch`, `listActiveSubscriptions`, `normalizeToMonthly`, `computeMrr`, types, `StripeApiError`, `ZERO_DECIMAL` |
| `app/api/projects/[slug]/revenue/route.ts` | the Revenue API route (auth + envelope) |
| `components/RevenueTab.tsx` | client island: fetches the route, renders MRR + subscriptions |
| `app/p/[slug]/page.tsx` | conditional `Revenue` tab |
| `app/globals.css` | minimal `.revenue-*` classes (theme tokens only) |
| `cli/index.ts` | `--stripe-site` flag on `project add`/`update` + coerce + spec registry |
| `cli/README.md`, `AGENTS.md` | document `--stripe-site` |
| `.env.example` | document `STRIPE_SECRET_KEY` |
| `test/stripe-api.test.ts` | fetch-mocked unit tests for the client |
| `test/stripe-site-field.test.ts` | column-persistence test (node+DB) |

---

## Task 1: Data model — `stripeSite` column + mutations + persistence test

**Files:**
- Modify: `lib/db/schema.ts` (projects table, after `emailAddress`)
- Modify: `lib/mutations.ts` (`ProjectInput`, `createProject`, `updateProject`)
- Create: `migrations/NNNN_*.sql` (generated)
- Test: `test/stripe-site-field.test.ts`

- [ ] **Step 1: Write the failing persistence test**

Create `test/stripe-site-field.test.ts` (mirrors `test/sentry-project-field.test.ts` — open that file to copy its imports/setup exactly if anything below differs from the repo helpers):

```ts
// ABOUTME: Verifies the projects.stripeSite column persists through createProject/updateProject.

import { describe, it, expect, afterAll } from 'vitest';
import { createProject, updateProject } from '../lib/mutations';
import { getProjectBySlug } from '../lib/queries';
import { db } from '../lib/db';
import { projects } from '../lib/db/schema';
import { eq } from 'drizzle-orm';

const created: string[] = [];

afterAll(async () => {
  for (const id of created) await db.delete(projects).where(eq(projects.id, id));
});

describe('projects.stripeSite', () => {
  it('persists on create and is readable via getProjectBySlug', async () => {
    const p = await createProject({
      name: `Stripe Site Test ${Date.now()}`,
      category: 'app',
      status: 'live',
      stripeSite: 'memoiries',
    });
    created.push(p.id);
    expect(p.stripeSite).toBe('memoiries');
    const fetched = await getProjectBySlug(p.slug);
    expect(fetched?.stripeSite).toBe('memoiries');
  });

  it('updates and clears to null', async () => {
    const p = await createProject({
      name: `Stripe Site Test2 ${Date.now()}`,
      category: 'app',
      status: 'live',
    });
    created.push(p.id);
    expect(p.stripeSite).toBeNull();

    const updated = await updateProject(p.id, { stripeSite: 'ticc' });
    expect(updated?.stripeSite).toBe('ticc');

    const cleared = await updateProject(p.id, { stripeSite: null });
    expect(cleared?.stripeSite).toBeNull();
  });
});
```

> Note: `category: 'app'` and `status: 'live'` must be valid enum values. If `mc enums --json` or `lib/db/enums` shows different valid values, use a valid one (e.g. whatever `test/sentry-project-field.test.ts` uses). Match that file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/stripe-site-field.test.ts`
Expected: FAIL — `stripeSite` is not a known property / TS error or `undefined` returned (the column does not exist yet).

- [ ] **Step 3: Add the column to the schema**

In `lib/db/schema.ts`, in the `projects` table, add immediately after the `emailAddress` line:

```ts
    emailAddress: text('email_address'),   // nullable; manual primary email address
    stripeSite: text('stripe_site'),       // nullable; metadata.site value, null = no Revenue tab
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`
Expected: a new file `migrations/NNNN_*.sql` containing exactly `ALTER TABLE "projects" ADD COLUMN "stripe_site" text;`. **Open it and verify** it contains only that `ADD COLUMN` (plus drizzle's snapshot files) — no stray statements, no grants.

- [ ] **Step 5: Add `stripeSite` to `ProjectInput`**

In `lib/mutations.ts`, in the `ProjectInput` type, after `emailAddress?: string | null;`:

```ts
  emailAddress?: string | null;
  stripeSite?: string | null;
```

(`ProjectUpdate = Partial<ProjectInput>` picks this up automatically.)

- [ ] **Step 6: Wire `stripeSite` into `createProject`**

In `lib/mutations.ts`, in `createProject`'s `.values({...})`, after `emailAddress: input.emailAddress ?? null,`:

```ts
      emailAddress: input.emailAddress ?? null,
      stripeSite: input.stripeSite ?? null,
```

- [ ] **Step 7: Wire `stripeSite` into `updateProject`**

In `lib/mutations.ts`, in `updateProject`, after `if (input.emailAddress !== undefined) set.emailAddress = input.emailAddress;`:

```ts
  if (input.emailAddress !== undefined) set.emailAddress = input.emailAddress;
  if (input.stripeSite !== undefined) set.stripeSite = input.stripeSite;
```

- [ ] **Step 8: Apply the migration to the dev DB**

Run: `npm run db:migrate`
Expected: applies cleanly; the `stripe_site` column now exists on the dev Neon branch.

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run test/stripe-site-field.test.ts`
Expected: PASS (both tests).

- [ ] **Step 10: Commit**

```bash
git add lib/db/schema.ts lib/mutations.ts migrations/ test/stripe-site-field.test.ts
git commit -m "feat(stripe): add projects.stripeSite column + persistence"
```

---

## Task 2: `lib/stripe.ts` mapping helper

**Files:**
- Create: `lib/stripe.ts`

This helper has no I/O, so it's covered by the route's behavior and the API test indirectly; it's tiny and mirrors `lib/sentry.ts`. No separate unit test (matches `lib/sentry.ts`, which has none of its own).

- [ ] **Step 1: Create `lib/stripe.ts`**

```ts
// ABOUTME: Maps a project (stripeSite) to a Stripe metadata.site filter. The sentryProjectRef analog.

export type StripeSiteRef = { site: string };

/** A project's Stripe site ref, or null when unmapped (no stripeSite set). */
export function stripeSiteRef(p: { stripeSite: string | null }): StripeSiteRef | null {
  if (!p.stripeSite) return null;
  return { site: p.stripeSite };
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add lib/stripe.ts
git commit -m "feat(stripe): add stripeSiteRef mapping helper"
```

---

## Task 3: `lib/stripe-api.ts` REST client (TDD)

**Files:**
- Create: `lib/stripe-api.ts`
- Test: `test/stripe-api.test.ts`

This is the heart of the slice. Build it test-first. The test mocks `globalThis.fetch` exactly like `test/sentry-api.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/stripe-api.test.ts`:

```ts
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

// A raw Stripe subscription as returned by the Search API (only the fields we read).
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
    // Always returns has_more:true with a next page → the loop must stop at MAX_PAGES (10).
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/stripe-api.test.ts`
Expected: FAIL — `Cannot find module '../lib/stripe-api'`.

- [ ] **Step 3: Implement `lib/stripe-api.ts`**

```ts
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
  amountMinor: number; // unit_amount * quantity, in the currency's minor unit
  currency: string; // lowercase ISO (Stripe convention)
  interval: string; // day | week | month | year
  intervalCount: number;
  quantity: number;
  monthlyMinor: number; // this sub's MRR contribution, normalized to monthly (minor units)
  created: number; // unix seconds
};

export type RevenueSummary = {
  activeCount: number;
  mrrByCurrency: Record<string, number>; // currency -> MRR in minor units
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
  // The site is interpolated into the search query; a single quote would break/inject it.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/stripe-api.test.ts`
Expected: PASS (all `listActiveSubscriptions`, `normalizeToMonthly`, `computeMrr` cases).

- [ ] **Step 5: Commit**

```bash
git add lib/stripe-api.ts test/stripe-api.test.ts
git commit -m "feat(stripe): add stripe-api client (active subs, MRR, pagination)"
```

---

## Task 4: Revenue API route

**Files:**
- Create: `app/api/projects/[slug]/revenue/route.ts`

No unit-test harness for routes in this repo (matches the Errors slice); verified via `tsc` + `next build` in Task 7. Implement to exactly mirror `app/api/projects/[slug]/errors/route.ts`.

- [ ] **Step 1: Create the route**

```ts
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
```

> Verify the import path for `requireAllowedUser`/`UnauthorizedError` matches `app/api/projects/[slug]/errors/route.ts` exactly (`@/lib/authz`). If the errors route imports differently, match it.

- [ ] **Step 2: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "app/api/projects/[slug]/revenue/route.ts"
git commit -m "feat(stripe): add /api/projects/[slug]/revenue route"
```

---

## Task 5: `RevenueTab` component + CSS + detail-page wiring

**Files:**
- Create: `components/RevenueTab.tsx`
- Modify: `app/globals.css` (add `.revenue-*` block)
- Modify: `app/p/[slug]/page.tsx` (import + conditional tab)

- [ ] **Step 1: Create `components/RevenueTab.tsx`**

```tsx
// ABOUTME: Client component for the Revenue tab — fetches a site's active Stripe subscriptions + MRR.

'use client';

import { useState, useEffect } from 'react';
import { relativeTime } from '@/lib/ui';
import { ZERO_DECIMAL, type StripeSubscription, type RevenueSummary } from '@/lib/stripe-api';

type RevenueData = { site: string; subscriptions: StripeSubscription[]; summary: RevenueSummary };

type RevenueState =
  | { kind: 'loading' }
  | { kind: 'no_site' }
  | { kind: 'no_token' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; data: RevenueData };

function formatMoney(minor: number, currency: string): string {
  const amount = ZERO_DECIMAL.has(currency.toLowerCase()) ? minor : minor / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(amount);
  } catch {
    // Unknown/invalid currency code → fall back to a plain number + raw code.
    return `${amount.toLocaleString()} ${currency.toUpperCase()}`;
  }
}

export function RevenueTab({ slug }: { slug: string }) {
  const [state, setState] = useState<RevenueState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${slug}/revenue`)
      .then((r) => r.json())
      .then((json: { ok: boolean; error?: string; message?: string; data?: RevenueData }) => {
        if (cancelled) return;
        if (json.ok && json.data) {
          setState({ kind: 'data', data: json.data });
        } else if (json.error === 'no_stripe_site') {
          setState({ kind: 'no_site' });
        } else if (json.error === 'stripe_token_missing') {
          setState({ kind: 'no_token' });
        } else {
          setState({ kind: 'error', message: json.message ?? json.error ?? 'Unknown error' });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (state.kind === 'loading') {
    return (
      <div className="revenue-loading" aria-label="Loading revenue">
        <div className="skeleton-bar" />
        <div className="skeleton-bar" />
        <div className="skeleton-bar" />
      </div>
    );
  }

  if (state.kind === 'no_site') {
    return (
      <p className="detail-muted">
        No Stripe site linked. Set one with <code>mc project update {slug} --stripe-site &lt;id&gt;</code>.
      </p>
    );
  }

  if (state.kind === 'no_token') {
    return (
      <p className="detail-muted">
        Add <code>STRIPE_SECRET_KEY</code> to your environment to view revenue.
      </p>
    );
  }

  if (state.kind === 'error') {
    return <p className="revenue-error">Failed to load revenue: {state.message}</p>;
  }

  const { subscriptions, summary, site } = state.data;

  if (subscriptions.length === 0) {
    return (
      <p className="detail-muted">
        No active subscriptions for <code>{site}</code>.
      </p>
    );
  }

  const currencies = Object.keys(summary.mrrByCurrency).sort();

  return (
    <div className="revenue-panel">
      <div className="revenue-summary">
        {currencies.map((c) => (
          <span className="revenue-mrr" key={c}>
            {formatMoney(summary.mrrByCurrency[c], c)}/mo
          </span>
        ))}
        <span className="revenue-count"> · {summary.activeCount} active</span>
        {summary.truncated && <span className="revenue-trunc"> (showing first 1,000)</span>}
      </div>
      <ul className="revenue-list">
        {subscriptions.map((s) => (
          <li className="revenue-row" key={s.id}>
            <span className="revenue-customer">{s.customerName ?? s.customerEmail ?? '—'}</span>
            <span className="revenue-amount">
              {formatMoney(s.amountMinor, s.currency)} / {s.intervalCount > 1 ? `${s.intervalCount} ` : ''}
              {s.interval || '—'}
            </span>
            <span className="revenue-status">{s.status}</span>
            <span className="revenue-meta">{relativeTime(new Date(s.created * 1000))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Add the CSS block**

In `app/globals.css`, immediately after the Email tab block (after the `.email-error` line, currently ~line 1878), add:

```css

/* Revenue tab (Stripe active subscriptions + MRR). */
.revenue-summary { font-family: var(--font-mono); font-size: var(--fs-12); color: var(--ink-mute); margin-bottom: var(--space-md); }
.revenue-mrr { color: var(--ok); font-weight: 600; }
.revenue-mrr + .revenue-mrr { margin-left: var(--space-sm); }
.revenue-trunc { color: var(--ink-mute); }
.revenue-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
.revenue-row { display: flex; align-items: baseline; gap: var(--space-sm); padding: var(--space-sm); border: 1px solid var(--line); border-radius: var(--radius-sm); }
.revenue-customer { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.revenue-amount { font-family: var(--font-mono); font-size: var(--fs-12); }
.revenue-status { color: var(--ink-mute); font-size: var(--fs-11); }
.revenue-meta { color: var(--ink-mute); font-family: var(--font-mono); font-size: var(--fs-11); white-space: nowrap; }
.revenue-error { color: var(--bad); }
```

> These tokens (`--ink-mute`, `--ok`, `--bad`, `--line`, `--space-*`, `--fs-*`, `--radius-sm`, `--font-mono`) are all defined in `app/globals.css` and used by the `.errors-*`/`.email-*` blocks. Do NOT introduce hardcoded hex/oklch values.

- [ ] **Step 3: Wire the tab into the detail page**

In `app/p/[slug]/page.tsx`, add the import next to the other tab imports (after the `EmailTab` import on line ~21):

```tsx
import { EmailTab } from '@/components/EmailTab';
import { RevenueTab } from '@/components/RevenueTab';
```

Then in the `TabbedPanels` `tabs={[...]}` array, add the Revenue spread immediately after the Errors spread:

```tsx
              ...(project.sentryProjectSlug ? [
                { key: 'errors', label: 'Errors', content: <ErrorsTab slug={project.slug} /> },
              ] : []),
              ...(project.stripeSite ? [
                { key: 'revenue', label: 'Revenue', content: <RevenueTab slug={project.slug} /> },
              ] : []),
```

- [ ] **Step 4: Verify typecheck + build**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npx next build`
Expected: build succeeds; the route `/api/projects/[slug]/revenue` appears in the route list.

- [ ] **Step 5: Commit**

```bash
git add components/RevenueTab.tsx app/globals.css "app/p/[slug]/page.tsx"
git commit -m "feat(stripe): add RevenueTab component + detail-page tab"
```

---

## Task 6: CLI flag + docs + spec-sync

**Files:**
- Modify: `cli/index.ts` (coerce, both option blocks, spec registry ×2)
- Modify: `cli/README.md`, `AGENTS.md`
- Modify: `.env.example`

The repo enforces CLI↔spec parity in `test/spec-sync.test.ts`, so the flag must be added to both the live commands and the `mc spec` registry.

- [ ] **Step 1: Add coercion in `coerceProjectFields`**

In `cli/index.ts`, in `coerceProjectFields`, after the `emailAddress` line:

```ts
  if (opts.emailAddress !== undefined) out.emailAddress = String(opts.emailAddress) || null;
  if (opts.stripeSite !== undefined) out.stripeSite = String(opts.stripeSite) || null;
```

- [ ] **Step 2: Add the option to `project add`**

In `cli/index.ts`, in the `project add` command's option chain, after `.option('--email-address <addr>')`:

```ts
  .option('--email-address <addr>')
  .option('--stripe-site <id>')
```

- [ ] **Step 3: Add the option to `project update`**

In `cli/index.ts`, in the `project update` command's option chain, after `.option('--email-address <addr>')`:

```ts
  .option('--email-address <addr>')
  .option('--stripe-site <id>')
```

- [ ] **Step 4: Update the `mc spec` registry (both entries)**

In `cli/index.ts`, in the spec registry, append `'--stripe-site'` to the `options` array of BOTH the `project add` and `project update` entries (the lines currently ending `..., '--email-address'] }`):

```ts
  { name: 'project add', readonly: false, summary: 'Create a project', required: ['--name', '--category'], options: ['--status', '--accent', '--domain', '--tech', '--repo-path', '--repo-url', '--live-url', '--priority', '--notes', '--sentry-project', '--email-provider', '--email-address', '--stripe-site'] },
  { name: 'project update', readonly: false, summary: 'Update a project (only provided flags change)', args: ['<slug>'], options: ['--name', '--category', '--status', '--accent', '--domain', '--tech', '--repo-path', '--repo-url', '--live-url', '--priority', '--notes', '--sentry-project', '--email-provider', '--email-address', '--stripe-site'] },
```

- [ ] **Step 5: Run the spec-sync test to verify parity**

Run: `npx vitest run test/spec-sync.test.ts`
Expected: PASS (CLI options match the registry for both commands).

- [ ] **Step 6: Document the flag in `cli/README.md` and `AGENTS.md`**

In `cli/README.md` and `AGENTS.md`, find the `project add` line listing flags and append `--stripe-site` to the bracketed flag list (alongside `--email-provider --email-address`). In `AGENTS.md` the relevant line is the `mc project add` usage line:

```
mc project add <slug> ... [--sentry-project --email-provider --email-address --stripe-site]
```

Match the exact existing format on that line (it currently ends with `--email-provider --email-address`). Add `--stripe-site` after it.

- [ ] **Step 7: Document the env var in `.env.example`**

In `.env.example`, near the `SENTRY_AUTH_TOKEN` block, add:

```
# Stripe — read-only access for the project Revenue tab (active subscriptions + MRR).
# Single account; sites are segmented by subscription metadata.site (see ticc1/STRIPE.md).
STRIPE_SECRET_KEY=
```

- [ ] **Step 8: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add cli/index.ts cli/README.md AGENTS.md .env.example
git commit -m "feat(stripe): add --stripe-site CLI flag + docs + env"
```

---

## Task 7: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 2: Lint (scoped)**

Run: `npx eslint lib components app cli test`
Expected: no errors. (Do NOT run full `npm run lint` — it can crash on gitignored docs artifacts.)

- [ ] **Step 3: Build**

Run: `npx next build`
Expected: succeeds; `/api/projects/[slug]/revenue` listed.

- [ ] **Step 4: Full test suite**

Run: `npm test`
Expected: all tests pass, including the new `test/stripe-api.test.ts` and `test/stripe-site-field.test.ts`.

- [ ] **Step 5: Dogfood note**

The browser dogfood (link a real project via `mc project update <slug> --stripe-site <id>`, set a real `STRIPE_SECRET_KEY`, open the Revenue tab) is auth-gated and needs a real key + a site with active subscriptions. If it can't be exercised in this environment, note that explicitly in the PR description (mirrors the Email/Errors slices). Confirm at minimum the `no_site` and `no_token` states render by reasoning through the code.

---

## Self-Review (completed by plan author)

**Spec coverage:** schema+migration+mutations (Task 1) ✓; `stripeSiteRef` (Task 2) ✓; `stripe-api` client incl. pagination/`truncated`/quote-guard/`normalizeToMonthly`/`computeMrr`/`ZERO_DECIMAL` (Task 3) ✓; route with all five status branches (Task 4) ✓; `RevenueTab` states + per-currency MRR + truncated note + `formatMoney` (Task 5) ✓; CLI flag + spec-sync + README/AGENTS + `.env.example` (Task 6) ✓; full gate + dogfood caveat (Task 7) ✓. Out-of-scope items carry no tasks (correct).

**Type consistency:** `StripeSubscription`/`RevenueSummary`/`StripeSiteRef`/`StripeApiError` names are identical across `lib/stripe-api.ts`, the route, the component, and the tests. `listActiveSubscriptions` returns `{ subscriptions, truncated }` and the route destructures exactly that. `relativeTime(date: Date | string)` is fed `new Date(created*1000)` (matches its signature in `lib/ui.ts`). CSS tokens corrected to the real names (`--ink-mute`, not the spec's `--muted`).

**Placeholder scan:** no TBD/TODO; every code step shows full code; the only `NNNN` is the intentional drizzle-generated migration filename.

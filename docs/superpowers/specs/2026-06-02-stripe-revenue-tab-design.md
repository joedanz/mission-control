# Revenue (Stripe) tab — live MRR + active subscriptions per site

**Date:** 2026-06-02
**Status:** Approved (design)
**Scope:** One slice. The third and last live-integration tab (after Errors/Sentry and Email). A direct mirror of the Errors slice. The Integrations-tab reshape gets its own spec.

## Problem

The project detail page has live, per-project data tabs for GitHub (Commits, PRs), Errors (Sentry), and Email (DNS) — but nothing for revenue. Several projects bill through Stripe, and the operator has no in-app view of how a product is doing. We want a **Revenue** tab that shows a site's MRR and active subscriptions, visible only for projects mapped to a Stripe site.

## Goal

A read-only **Revenue** tab on the project detail page that shows a site's computed MRR and its active Stripe subscriptions, visible only for projects with a `stripeSite` mapping.

## Decisions (from brainstorming)

- **Stripe topology (from `ticc1/STRIPE.md`):** ONE Stripe account, ONE secret key (`STRIPE_SECRET_KEY`). Sites are NOT separate accounts/keys — they are segmented by `metadata.site` (the main part of the domain, no TLD: `memoiries.app` → `memoiries`, `ticc.net` → `ticc`), stamped on `subscription_data.metadata` at checkout.
- **Project → Stripe mapping:** a new nullable `stripeSite` column on `projects`. Its presence gates the tab (mirrors `sentryProjectSlug` exactly). Set via `mc project update --stripe-site <id>`. Explicit, not domain-derived — so the tab never appears empty on unrelated projects, and a billing id that differs from the bare domain still works.
- **Tab content (v1):** a summary header (computed MRR + active-subscription count) + a list of the site's active subscriptions. **Read-only** — no cancel/refund actions.
- **Auth:** single `STRIPE_SECRET_KEY` env (Bearer), mirroring `SENTRY_AUTH_TOKEN`. No `STRIPE_BASE_URL` indirection (Stripe's base is fixed: `https://api.stripe.com`).
- **Data source:** `metadata.site` is reliably stamped on **subscriptions** (charges/invoices do NOT inherit it), so the segmentation anchor is `/v1/subscriptions/search` — which also dictates the MRR/active-subscriptions view (rather than a raw-payments feed).
- **Integrations tab:** left as-is this slice. The reshape happens separately.

## Architecture

A direct mirror of the Errors (Sentry) slice: `lib/stripe.ts` (mapping helper) → `lib/stripe-api.ts` (fetch-based REST client, no SDK — consistent with `lib/sentry-api.ts` / `lib/github-api.ts`, so it runs on Vercel) → `app/api/projects/[slug]/revenue/route.ts` (standard `{ok,error,data}` envelope) → `'use client'` `RevenueTab` → conditional tab in `app/p/[slug]/page.tsx`. The detail page stays a Server Component; the tab is a client island that fetches the route.

### Two real differences from the Errors slice

1. **MRR is computed, not fetched.** Stripe has no MRR endpoint. We normalize each active subscription's price to a monthly figure and sum **per currency** (never across currencies). Amounts are minor units; zero-decimal currencies handled via a small known set.
2. **Search indexing lag + pagination.** Stripe's Search API lags writes by up to ~1 minute and pages at 100 results. We paginate to a safety cap and surface a `truncated` flag so a very large site never silently undercounts.

## Components

### 1. Data model + migration
- Add to the `projects` table in `lib/db/schema.ts`, after `emailAddress`:
  ```ts
  stripeSite: text('stripe_site'), // nullable; metadata.site value, null = no Revenue tab
  ```
- Generate the migration: `npm run db:generate` (drizzle-kit) → a new file under `migrations/`. It is a plain `ALTER TABLE projects ADD COLUMN stripe_site text;`. **Verify** the generated file contains ONLY the `ADD COLUMN` (no stray statements) before applying. Table-level grants on `projects` cover new columns (no column-level grants used), so no new `GRANT`.
- Apply with `npm run db:migrate` (dev DB). `getProjectBySlug` uses `select()` (all columns), so `stripeSite` flows to the detail page and `mc project get` automatically — no query change.

### 2. `lib/stripe.ts` (mapping helper — the `sentryProjectRef` analog)
```ts
// ABOUTME: Maps a project (stripeSite) to a Stripe metadata.site filter. The sentryProjectRef analog.

export type StripeSiteRef = { site: string };

/** A project's Stripe site ref, or null when unmapped (no stripeSite set). */
export function stripeSiteRef(p: { stripeSite: string | null }): StripeSiteRef | null {
  if (!p.stripeSite) return null;
  return { site: p.stripeSite };
}
```
*(Unlike `sentryProjectRef`, there's no env in the ref — the site value is self-contained. The token check lives in the route, mirroring Sentry.)*

### 3. `lib/stripe-api.ts` (REST client — the `lib/sentry-api.ts` analog)
- `StripeApiError extends Error` with optional `status`.
- `stripeFetch(path)` — `GET https://api.stripe.com{path}` with `Authorization: Bearer ${STRIPE_SECRET_KEY}`, `Accept: application/json`; throws `StripeApiError` on non-2xx (message includes status + truncated body).
- Types:
  ```ts
  export type StripeSubscription = {
    id: string;
    customerName: string | null;   // from expanded customer.name
    customerEmail: string | null;  // from expanded customer.email
    status: string;                // active (we only query active in v1)
    amountMinor: number;           // unit_amount * quantity, in the currency's minor unit
    currency: string;              // lowercase ISO (Stripe convention)
    interval: string;              // day | week | month | year
    intervalCount: number;         // recurring.interval_count
    quantity: number;
    monthlyMinor: number;          // this sub's MRR contribution, normalized to monthly (minor units)
    created: number;               // unix seconds (subscription.created)
  };

  export type RevenueSummary = {
    activeCount: number;                 // subscriptions returned (capped — see truncated)
    mrrByCurrency: Record<string, number>; // currency -> MRR in minor units
    truncated: boolean;                  // true if the pagination cap was hit
  };
  ```
- Constants: `SEARCH_PAGE_LIMIT = 100`, `MAX_PAGES = 10` (→ up to 1000 subs), `ZERO_DECIMAL = new Set(['bif','clp','djf','gnf','jpy','kmf','krw','mga','pyg','rwf','ugx','vnd','vuv','xaf','xof','xpf'])` (Stripe's zero-decimal currencies; used by the UI for display, exported for reuse).
- `listActiveSubscriptions(ref: StripeSiteRef): Promise<{ subscriptions: StripeSubscription[]; truncated: boolean }>`
  - Query string per page: `query=metadata['site']:'<site>' AND status:'active'`, `limit=100`, `expand[]=data.customer`, and `page=<next_page>` on subsequent pages.
    - Build with `URLSearchParams`; the site value is interpolated into the `query` string. **Reject** a site containing `'` (single quote) up front (throw `StripeApiError`) so the search query can't be broken/injected — site ids are `[a-z0-9-]`-ish by convention.
  - Calls `GET /v1/subscriptions/search?<qs>` repeatedly while `has_more` is true and page count < `MAX_PAGES`, following `next_page`.
  - Maps each raw subscription: take `item = items.data[0]` (v1 assumes a single price per sub — the common case; multi-item subs use the first item and are acceptable for a glance), read `item.price.unit_amount` (minor), `item.price.currency`, `item.price.recurring.interval`/`interval_count`, quantity from `item.quantity ?? 1` (quantity lives on the subscription item, not the subscription top-level, in current Stripe API versions), `customer` (expanded object → `name`/`email`; if `customer` is a bare id string, both null), `created`.
  - `amountMinor = (unit_amount ?? 0) * quantity`. `monthlyMinor = normalizeToMonthly(amountMinor, interval, intervalCount)`.
  - `truncated = has_more is still true after MAX_PAGES`.
- `normalizeToMonthly(amountMinor: number, interval: string, intervalCount: number): number` (exported for testing):
  - Guard `intervalCount < 1` → treat as 1.
  - `month` → `amountMinor / intervalCount`
  - `year` → `amountMinor / (12 * intervalCount)`
  - `week` → `amountMinor * 52 / 12 / intervalCount`
  - `day` → `amountMinor * 365 / 12 / intervalCount`
  - unknown interval → `0` (excluded from MRR rather than guessed)
  - Returns a rounded integer (`Math.round`) — minor units stay integral.
- `computeMrr(subs: StripeSubscription[]): Record<string, number>` (exported for testing): sum `monthlyMinor` into a `{ [currency]: total }` map. Never sums across currencies.

### 4. Route `app/api/projects/[slug]/revenue/route.ts` (the errors-route analog)
- `runtime='nodejs'`, `dynamic='force-dynamic'`.
- `requireAllowedUser()` → 401 `{ok:false,error:'unauthorized'}`.
- `getProjectBySlug(slug)` → 404 `{ok:false,error:'not_found'}`.
- `stripeSiteRef(project)` null → 422 `{ok:false,error:'no_stripe_site'}`.
- `!process.env.STRIPE_SECRET_KEY` → 503 `{ok:false,error:'stripe_token_missing'}`.
- else: `const { subscriptions, truncated } = await listActiveSubscriptions(ref)`, build
  `summary = { activeCount: subscriptions.length, mrrByCurrency: computeMrr(subscriptions), truncated }`,
  return `{ok:true, data:{ site: ref.site, subscriptions, summary }}`.
- `catch (StripeApiError)` → `{ok:false, error:'stripe_api_error', message}` with `status ?? 502`.

### 5. `components/RevenueTab.tsx` (the `ErrorsTab` analog)
- `'use client'`. On mount, `fetch('/api/projects/${slug}/revenue')`; discriminated state: `loading | no_site | no_token | error | data` (maps `no_stripe_site`→`no_site`, `stripe_token_missing`→`no_token`, like ErrorsTab).
- States:
  - `no_site`: "No Stripe site linked. Set one with `mc project update <slug> --stripe-site <id>`."
  - `no_token`: "Add `STRIPE_SECRET_KEY` to view revenue." with a short hint.
  - `error`: "Failed to load revenue: {message}".
  - `data` empty (no subscriptions): "No active subscriptions for `<site>`."
  - `data`: summary header — one MRR line per currency: `{formatMoney(mrr, currency)}/mo · {activeCount} active`. If `truncated`, append a muted "(showing first 1,000)" note. Then a list; each row: customer (`customerName ?? customerEmail ?? '—'`), amount (`{formatMoney(amountMinor, currency)} / {intervalCount>1 ? intervalCount+' ' : ''}{interval}`), `status`, started (`relativeTime` of the subscription start — convert `created` unix-seconds to whatever `relativeTime` in `lib/ui` accepts; check its signature, since the other tabs pass it an ISO string).
  - `formatMoney(minor, currency)`: divide by 100 unless `ZERO_DECIMAL.has(currency)` (then no division), format via `Intl.NumberFormat(undefined, { style:'currency', currency: currency.toUpperCase() })`.

  Layout target:
  ```
  Revenue — memoiries
  ─────────────────────────────────────────────────────────
  $1,240.00/mo · 18 active
    Jane Cooper        $12.00 / month      active   3mo ago
    acme@example.com   $120.00 / year      active   1mo ago
    …
  ```
  Reuse existing `relativeTime` from `lib/ui`. Add minimal `.revenue-*` classes to `app/globals.css` using theme tokens (`var(--ok)`, `var(--muted)`, etc.) — NO hardcoded hex.

### 6. Detail page — `app/p/[slug]/page.tsx`
- Import `RevenueTab`; add a conditional tab (mirrors the Errors/`sentryProjectSlug` spread), placed AFTER the Email and Errors tabs:
  ```tsx
  ...(project.stripeSite ? [
    { key: 'revenue', label: 'Revenue', content: <RevenueTab slug={project.slug} /> },
  ] : []),
  ```
- Nothing else on the page changes (Integrations tab stays).

### 7. CLI + config
- `cli/index.ts`:
  - Add `.option('--stripe-site <id>')` to both `project add` and `project update`.
  - In `coerceProjectFields(opts)`, add: `if (opts.stripeSite !== undefined) out.stripeSite = String(opts.stripeSite) || null;`
  - Add `--stripe-site` to the `mc spec` options arrays for `project add` and `project update`.
- `lib/mutations.ts`:
  - Add `stripeSite?: string | null;` to `ProjectInput` (and `ProjectUpdate` if it is a distinct type).
  - In `createProject`, set `stripeSite: input.stripeSite ?? null`.
  - In `updateProject`, add `if (input.stripeSite !== undefined) set.stripeSite = input.stripeSite;`
- `cli/README.md` + `AGENTS.md` CLI block: add `--stripe-site` to the `project add` flag list (the `project update` lines use the "any add flag" shorthand — no change needed there).
- `.env.example`: document `STRIPE_SECRET_KEY` (Stripe secret key, `sk_live_...` / `sk_test_...`; read-only usage here).

## Data flow
```
RevenueTab (client) → GET /api/projects/[slug]/revenue
  → requireAllowedUser → getProjectBySlug → stripeSiteRef
  → listActiveSubscriptions → stripeFetch → api.stripe.com (Search API, paginated)
  → computeMrr → { site, subscriptions, summary }
```
No polling (one fetch on tab open), matching the other live tabs.

## Error / empty states
Explicit and surfaced (never silent): `no_site`, `no_token`, `error` (with message), and empty (`No active subscriptions`). The `truncated` flag is shown when the pagination cap is hit so the MRR/count is never silently undercounted. The token/mapping states tell the operator exactly how to fix it.

## Testing
The repo's tests are node + real Neon DB; `lib/sentry-api.ts` is unit-tested by mocking `globalThis.fetch` (`test/sentry-api.test.ts`). This slice mirrors that:

1. **`test/stripe-api.test.ts` (required, TDD):** stub `globalThis.fetch` (mirror the sentry-api test helpers) and assert:
   - `listActiveSubscriptions` builds the correct URL (`/v1/subscriptions/search`) with `query=metadata['site']:'<site>' AND status:'active'`, `limit=100`, `expand[]=data.customer`,
   - sends the `Authorization: Bearer` header from `STRIPE_SECRET_KEY`,
   - maps a raw subscription → `StripeSubscription` (amount = unit_amount×quantity, expanded customer name/email, bare-id customer → nulls),
   - **paginates**: a first response with `has_more:true` + `next_page` triggers a second request with `page=<next_page>`, and results concatenate,
   - sets `truncated:true` when `has_more` is still true after `MAX_PAGES`,
   - rejects a site containing a single quote with `StripeApiError`,
   - throws `StripeApiError` (with status) on a non-2xx response.
   - `normalizeToMonthly`: month/year/week/day each normalize correctly, `intervalCount>1` divides, unknown interval → 0, result is integral.
   - `computeMrr`: sums `monthlyMinor` per currency and keeps currencies separate.
2. **`test/stripe-site-field.test.ts` (required):** a node+DB test (mirroring `test/sentry-project-field.test.ts`) that `createProject`/`updateProject` persist `stripeSite` and `getProjectBySlug` returns it; passing `null`/empty clears it.
3. **spec-sync:** `test/spec-sync.test.ts` enforces the CLI options match the `mc spec` registry — update both `project add` and `project update`.
4. **Route + `RevenueTab`:** no component-test harness exists, so verify via `npx tsc --noEmit`, scoped `eslint`, `npx next build`, and an auth-gated browser dogfood (link a real project via `--stripe-site`, open the Revenue tab with a real `STRIPE_SECRET_KEY`, confirm MRR + subscriptions render, and confirm the `no_site`/`no_token` states). The dogfood requires a real key + a site with active subs — note in the PR if it can't be fully exercised.

## Files touched
| File | Change |
|------|--------|
| `lib/db/schema.ts` | add `stripeSite` to `projects` |
| `migrations/NNNN_*.sql` | **new** — `ADD COLUMN stripe_site` (drizzle-generated) |
| `lib/stripe.ts` | **new** — `stripeSiteRef` mapping helper |
| `lib/stripe-api.ts` | **new** — `stripeFetch`, `listActiveSubscriptions`, `normalizeToMonthly`, `computeMrr`, types, `StripeApiError`, `ZERO_DECIMAL` |
| `app/api/projects/[slug]/revenue/route.ts` | **new** — the revenue API route |
| `components/RevenueTab.tsx` | **new** — client Revenue tab |
| `app/p/[slug]/page.tsx` | add conditional `Revenue` tab |
| `lib/mutations.ts` | `stripeSite` in `ProjectInput`(/`ProjectUpdate`), create/update |
| `cli/index.ts` | `--stripe-site` flag + field map + spec registry |
| `cli/README.md`, `AGENTS.md` | document `--stripe-site` |
| `.env.example` | document `STRIPE_SECRET_KEY` |
| `test/stripe-api.test.ts` | **new** — fetch-mocked unit tests |
| `test/stripe-site-field.test.ts` | **new** — column persistence test |
| `app/globals.css` | minimal `revenue-*` classes (theme tokens only) |

## Out of scope
- Charges/invoices feed, account balance, churn/growth trends.
- Write actions (cancel/refund/pause).
- The Stripe webhook handler in `ticc1/STRIPE.md` (that's the billed apps' server-side concern, not Mission Control).
- The Integrations-tab reshape (separate, later).
- Multi-item subscription precision (v1 uses the first price item per subscription).
- Stripe Connect / multiple accounts (single `STRIPE_SECRET_KEY`, single account — per `ticc1/STRIPE.md`).

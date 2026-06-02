# Email tab — DNS verification + provider detection

**Date:** 2026-06-02
**Status:** Approved (design)
**Scope:** One slice. The second live-integration tab (after Errors/Sentry). Provider-agnostic. The Stripe slice and the Integrations-tab reshape get their own specs.

## Problem

Projects have a `domain` but no visibility into whether email is correctly configured for it, or which provider hosts it. The old Zoho matrix only showed a tri-state setup status and assumed Zoho. We want an **Email** tab that verifies a domain's email DNS (MX/SPF/DMARC), infers the provider from MX, and lets the operator manually record provider + primary address when detection isn't enough — since not every project is on Zoho.

## Goal

A read-only **Email** tab on the project detail page that, for a project with a `domain`, shows: the email provider (manually set, else detected from MX, else "Unknown"), the manual primary address if recorded, and a MX/SPF/DMARC checklist with the actual record values. Visible only when the project has a `domain`.

## Decisions (from brainstorming)

- **Data source:** server-side DNS lookups (`node:dns/promises`) on the project's `domain`. No external API, no auth/token. Provider-agnostic.
- **Provider detection:** inferred from MX hostnames via a small suffix map; unknown providers show the raw MX host.
- **Manual override:** two new nullable columns — `emailProvider` (label) and `emailAddress` (primary address) — CLI-settable; shown/used when set.
- **DNS scope:** generic MX, SPF (`v=spf1` TXT), DMARC (`_dmarc` TXT). DKIM is out of scope (selector-dependent).
- **Legacy:** `ZOHO_EMAIL_LOCALPART` env and the `email_aliases` setting are superseded by this model; left untouched but unused by this tab.

## Architecture

Mirrors the Errors (Sentry) slice: `lib/email-dns.ts` helper → `app/api/projects/[slug]/email/route.ts` route (standard `{ok,error,data}` envelope) → `'use client'` `EmailTab` → conditional tab in `app/p/[slug]/page.tsx`. Difference from Errors: no token/env (DNS is unauthenticated), and the per-project key is the existing `domain` field plus two new manual columns.

## Components

### 1. Data model + migration
- Add two nullable columns to `projects` in `lib/db/schema.ts` (after `sentryProjectSlug`): `emailProvider: text('email_provider')`, `emailAddress: text('email_address')`.
- `npm run db:generate` → a new `migrations/NNNN_*.sql` (`ADD COLUMN` ×2); `npm run db:migrate` applies to the dev DB. Table-level grants cover new columns.
- `lib/mutations.ts`: add `emailProvider?: string | null` and `emailAddress?: string | null` to `ProjectInput`; set both (`?? null`) in `createProject`; add both to `updateProject`'s `!== undefined` whitelist.
- `getProjectBySlug` uses `select()`, so both flow through automatically.

### 2. `lib/email-dns.ts`
- `export type EmailDnsResult = { mx: { present: boolean; records: string[] }; spf: { present: boolean; record: string | null }; dmarc: { present: boolean; record: string | null }; detectedProvider: string | null }`.
- `checkEmailDns(domain: string): Promise<EmailDnsResult>`:
  - `dns.resolveMx(domain)` → sorted by priority; `records` = `exchange` hosts; `present` = non-empty.
  - `dns.resolveTxt(domain)` → join each record's chunks; SPF = the one starting `v=spf1` (case-insensitive); `present`/`record`.
  - `dns.resolveTxt('_dmarc.' + domain)` → DMARC = the one starting `v=DMARC1`; `present`/`record`.
  - Run the three lookups with `Promise.allSettled`; treat `ENOTFOUND`/`ENODATA` (and any rejection) as "not present" (empty), NOT a thrown error — a domain legitimately may lack any one record.
  - `detectedProvider` = `detectProvider(mx.records)`.
- `detectProvider(mxHosts: string[]): string | null` — lowercase-match MX host suffixes:
  - `zoho.` → "Zoho Mail"; `google.com`/`googlemail.com`/`aspmx.l.google.com` → "Google Workspace"; `outlook.com`/`.protection.outlook.com` → "Microsoft 365"; `proton.me`/`protonmail.` → "Proton Mail"; `messagingengine.com` → "Fastmail"; `icloud.com`/`mail.me.com` → "iCloud"; else `null`.

### 3. Route `app/api/projects/[slug]/email/route.ts`
- `runtime='nodejs'`, `dynamic='force-dynamic'`.
- `requireAllowedUser()`→401 `unauthorized`; `getProjectBySlug`→404 `not_found`; `!project.domain`→422 `no_domain`.
- else: `const checks = await checkEmailDns(project.domain)`; return `{ ok:true, data:{ domain: project.domain, checks, detectedProvider: checks.detectedProvider, manual: { provider: project.emailProvider, address: project.emailAddress } } }`.
- Wrap `checkEmailDns` in try/catch; an unexpected resolver failure → `{ ok:false, error:'email_dns_error', message }` status 502. (Per-record absence is already handled inside `checkEmailDns`, so this catch is for genuine failures only.)

### 4. `components/EmailTab.tsx`
- `'use client'`. Fetches `/api/projects/${slug}/email`. States: `loading | no_domain | error | data` (maps `no_domain`→no_domain, else generic error).
- `no_domain`: "No domain set for this project. Add one with `mc project update <slug> --domain <domain>`."
- `data`: header shows the domain + provider (`manual.provider ?? detectedProvider ?? 'Unknown'`, with a "(manually set)" hint when `manual.provider`); primary address line if `manual.address`; then a checklist of MX / SPF / DMARC, each a ✓/✗ with the record value(s) (muted, monospace). Reuse the `.errors-*`-style classes or add minimal `.email-*` classes.

Layout target:
```
Email — example.com                          Provider: Google Workspace
─────────────────────────────────────────────────────────────
Primary: hello@example.com   (manually set)
  ✓ MX      aspmx.l.google.com, alt1.aspmx.l.google.com
  ✓ SPF     v=spf1 include:_spf.google.com ~all
  ✗ DMARC   not found
```

### 5. Detail page — `app/p/[slug]/page.tsx`
- Import `EmailTab`; add a conditional tab (mirrors the Errors/`sentryProjectSlug` spread), placed before the Errors tab for a natural order:
  ```tsx
  ...(project.domain ? [
    { key: 'email', label: 'Email', content: <EmailTab slug={project.slug} /> },
  ] : []),
  ```
- Integrations tab untouched.

### 6. CLI + config
- `cli/index.ts`: `.option('--email-provider <name>')` and `.option('--email-address <addr>')` on `project add` + `project update`; in `coerceProjectFields`, `out.emailProvider`/`out.emailAddress` (`String(x) || null`); append both flags to the `mc spec` registry options arrays for `project add` + `project update`.
- `cli/README.md` + `AGENTS.md`: add the two flags to the `project add` flag list (the `project update` lines use the "any add flag" shorthand — no change needed there).
- **No new env.** `ZOHO_EMAIL_LOCALPART` / `email_aliases` left as-is (legacy, unused by this tab).

## Data flow
```
EmailTab (client) → GET /api/projects/[slug]/email
  → requireAllowedUser → getProjectBySlug → checkEmailDns(domain) [node:dns]
  → { domain, checks, detectedProvider, manual }
```
One fetch on tab open (no polling), matching the other live tabs.

## Error / empty states
- `no_domain` (422) — operator hint to set a domain.
- Per-record absence → rendered as ✗ "not found" (NOT an error).
- `email_dns_error` (502) — only for an unexpected resolver failure; rendered as the generic error state.

## Testing
- **`test/email-dns.test.ts` (required, TDD):** mock `node:dns/promises` (`vi.mock('node:dns/promises', …)` or inject) and assert `checkEmailDns` parses MX/SPF/DMARC correctly, treats `ENOTFOUND`/`ENODATA` as not-present (no throw), joins multi-chunk TXT records, and that `detectProvider` maps the known MX suffixes (Zoho/Google/Microsoft/Proton/Fastmail/iCloud) and returns null for unknown.
- **Column persistence (required):** a node+DB test (mirroring `test/sentry-project-field.test.ts`) that `createProject`/`updateProject` persist `emailProvider` + `emailAddress` and clearing to null works.
- **spec-sync:** `test/spec-sync.test.ts` enforces the CLI options match the registry — update both.
- **Route + `EmailTab`:** no component-test harness → verify via `npx tsc --noEmit`, scoped `eslint`, `npx next build`, and an auth-gated browser dogfood (a project with a real domain shows MX/SPF/DMARC + detected provider; a project with no domain shows `no_domain`).

## Files touched
| File | Change |
|------|--------|
| `lib/db/schema.ts` | add `emailProvider`, `emailAddress` to `projects` |
| `migrations/NNNN_*.sql` | **new** — `ADD COLUMN` ×2 (generated) |
| `lib/email-dns.ts` | **new** — `checkEmailDns` + `detectProvider` |
| `app/api/projects/[slug]/email/route.ts` | **new** — email DNS route |
| `components/EmailTab.tsx` | **new** — client Email tab |
| `app/p/[slug]/page.tsx` | add conditional `Email` tab |
| `lib/mutations.ts` | `emailProvider`/`emailAddress` in `ProjectInput`, create/update |
| `cli/index.ts` | `--email-provider`/`--email-address` flags + map + spec registry |
| `cli/README.md`, `AGENTS.md` | document the new flags |
| `app/globals.css` | minimal `.email-*` classes if needed |
| `test/email-dns.test.ts` | **new** — dns-mocked unit tests |
| `test/email-fields.test.ts` | **new** — column persistence test |

## Out of scope
- Zoho/Google/Microsoft API calls (DNS only).
- DKIM verification (selector-dependent).
- The Integrations-tab reshape.
- Removing the legacy `ZOHO_EMAIL_LOCALPART` / `email_aliases` (separate cleanup).

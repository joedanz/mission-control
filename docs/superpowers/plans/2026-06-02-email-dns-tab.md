# Email (DNS) Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only **Email** tab to the project detail page that verifies a domain's email DNS (MX/SPF/DMARC), infers the provider from MX, and shows manually-recorded provider/address — for any project with a `domain`.

**Architecture:** Mirrors the just-merged Errors (Sentry) slice: a `lib/email-dns.ts` helper (`node:dns/promises`, no auth) → `app/api/projects/[slug]/email/route.ts` route (standard `{ok,error,data}` envelope) → `'use client'` `EmailTab` → conditional tab in `app/p/[slug]/page.tsx`. Two new nullable columns (`emailProvider`, `emailAddress`) hold the manual override; the per-project key is the existing `domain`.

**Tech Stack:** Next.js (App Router), TypeScript, Drizzle/Neon, `node:dns/promises`, Vitest (node env; DNS mocked via `vi.mock`).

**Branch:** `feat/email-dns-tab` (already created; spec committed there).

**Spec:** `docs/superpowers/specs/2026-06-02-email-dns-tab-design.md`

---

## Conventions
- Typecheck: `npx tsc --noEmit` (Expected: clean, exit 0).
- Single test file: `npx vitest run test/<file>.test.ts`. Tests run node-env against the real Neon dev DB; the DNS test mocks `node:dns/promises` (no network).
- **Git:** stage explicit paths only — NEVER `git add -A`/`.`, `git stash`, `git reset`, `git checkout`, `git restore`, `git clean`. A stash holds unrelated docs work; never touch it. Commit per task.
- No component/jsdom test harness — components verified via `tsc` + `next build` + dogfood. Do not add jsdom tests.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `lib/db/schema.ts` | add `emailProvider`, `emailAddress` to `projects` | Modify |
| `migrations/NNNN_*.sql` | generated `ADD COLUMN` ×2 | New (generated) |
| `lib/mutations.ts` | accept the two fields in create/update | Modify |
| `lib/email-dns.ts` | `checkEmailDns` + `detectProvider` | New |
| `app/api/projects/[slug]/email/route.ts` | Email DNS route | New |
| `components/EmailTab.tsx` | client Email tab | New |
| `app/p/[slug]/page.tsx` | conditional `Email` tab | Modify |
| `cli/index.ts` | `--email-provider`/`--email-address` flag + map + registry | Modify |
| `cli/README.md`, `AGENTS.md` | document the flags | Modify |
| `app/globals.css` | minimal `.email-*` classes | Modify |
| `test/email-dns.test.ts` | dns-mocked unit tests | New |
| `test/email-fields.test.ts` | column persistence test | New |

---

## Task 1: `emailProvider` + `emailAddress` columns + mutation wiring

**Files:** Modify `lib/db/schema.ts`, `lib/mutations.ts`; Create `migrations/NNNN_*.sql` (generated), `test/email-fields.test.ts`.

- [ ] **Step 1: Write the failing DB test** — create `test/email-fields.test.ts`:

```ts
// ABOUTME: Verifies projects.emailProvider/emailAddress persist via createProject/updateProject.

import { describe, it, expect, afterAll } from 'vitest';
import { createProject, updateProject, deleteProject } from '../lib/mutations';
import { getProjectBySlug } from '../lib/queries';

const created: string[] = [];
afterAll(async () => { for (const id of created) await deleteProject(id); });

describe('projects email columns', () => {
  it('persist through create + update + clear', async () => {
    const p = await createProject({
      name: `Email Field Test ${Date.now()}`,
      category: 'internal',
      status: 'prelaunch',
      emailProvider: 'Google Workspace',
      emailAddress: 'hello@example.com',
    });
    created.push(p.id);
    const a = await getProjectBySlug(p.slug);
    expect(a?.emailProvider).toBe('Google Workspace');
    expect(a?.emailAddress).toBe('hello@example.com');

    await updateProject(p.id, { emailProvider: 'Zoho Mail' });
    expect((await getProjectBySlug(p.slug))?.emailProvider).toBe('Zoho Mail');

    await updateProject(p.id, { emailProvider: null, emailAddress: null });
    const c = await getProjectBySlug(p.slug);
    expect(c?.emailProvider).toBeNull();
    expect(c?.emailAddress).toBeNull();
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `npx vitest run test/email-fields.test.ts`
Expected: FAIL (TS: `emailProvider`/`emailAddress` not on `ProjectInput`/`Project`).

- [ ] **Step 3: Add the columns** — in `lib/db/schema.ts`, in the `projects` column list after `sentryProjectSlug: text('sentry_project_slug'), …`:

```ts
    emailProvider: text('email_provider'), // nullable; manual provider label override
    emailAddress: text('email_address'),   // nullable; manual primary email address
```

- [ ] **Step 4: Generate + apply migration**

Run: `npm run db:generate`
Expected: a new `migrations/NNNN_*.sql` with two `ALTER TABLE "projects" ADD COLUMN …` statements (`email_provider`, `email_address`). Open it; confirm only those ADD COLUMNs.

Run: `npm run db:migrate`
Expected: applies to the Neon dev DB without error.

- [ ] **Step 5: Wire into mutations** — in `lib/mutations.ts`:

Add to `ProjectInput` (after `sentryProjectSlug?: string | null;`):
```ts
  emailProvider?: string | null;
  emailAddress?: string | null;
```
In `createProject`'s `.values({ … })` (after `sentryProjectSlug: input.sentryProjectSlug ?? null,`):
```ts
      emailProvider: input.emailProvider ?? null,
      emailAddress: input.emailAddress ?? null,
```
In `updateProject`'s whitelist (after the `sentryProjectSlug` line):
```ts
  if (input.emailProvider !== undefined) set.emailProvider = input.emailProvider;
  if (input.emailAddress !== undefined) set.emailAddress = input.emailAddress;
```

- [ ] **Step 6: Run → pass**

Run: `npx vitest run test/email-fields.test.ts`
Expected: PASS (1 test).

- [ ] **Step 7: Typecheck + commit**

Run: `npx tsc --noEmit` → clean.
```bash
git add lib/db/schema.ts lib/mutations.ts migrations/ test/email-fields.test.ts
git commit -m "feat(projects): add emailProvider/emailAddress columns + mutation wiring"
```

---

## Task 2: `lib/email-dns.ts` — DNS checks + provider detection

**Files:** Create `lib/email-dns.ts`, `test/email-dns.test.ts`.

- [ ] **Step 1: Write the failing test** — create `test/email-dns.test.ts`:

```ts
// ABOUTME: Unit tests for lib/email-dns — mocks node:dns/promises; no network.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:dns/promises', () => ({ resolveMx: vi.fn(), resolveTxt: vi.fn() }));
import { resolveMx, resolveTxt } from 'node:dns/promises';
import { checkEmailDns, detectProvider } from '../lib/email-dns';

const mx = vi.mocked(resolveMx);
const txt = vi.mocked(resolveTxt);

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

beforeEach(() => { mx.mockReset(); txt.mockReset(); });

describe('detectProvider', () => {
  it('maps known MX suffixes', () => {
    expect(detectProvider(['aspmx.l.google.com'])).toBe('Google Workspace');
    expect(detectProvider(['mx.zoho.com'])).toBe('Zoho Mail');
    expect(detectProvider(['acme-com.mail.protection.outlook.com'])).toBe('Microsoft 365');
    expect(detectProvider(['mail.example.net'])).toBeNull();
  });
});

describe('checkEmailDns', () => {
  it('parses MX (priority-sorted), SPF, DMARC, and detects provider', async () => {
    mx.mockResolvedValue([
      { priority: 20, exchange: 'alt1.aspmx.l.google.com' },
      { priority: 10, exchange: 'aspmx.l.google.com' },
    ]);
    txt.mockImplementation((name: string) =>
      name.startsWith('_dmarc.')
        ? Promise.resolve([['v=DMARC1; p=none']])
        : Promise.resolve([['some=other'], ['v=spf1 include:_spf.google.com ~all']]),
    );

    const r = await checkEmailDns('example.com');
    expect(r.mx).toEqual({ present: true, records: ['aspmx.l.google.com', 'alt1.aspmx.l.google.com'] });
    expect(r.spf).toEqual({ present: true, record: 'v=spf1 include:_spf.google.com ~all' });
    expect(r.dmarc).toEqual({ present: true, record: 'v=DMARC1; p=none' });
    expect(r.detectedProvider).toBe('Google Workspace');
  });

  it('treats ENOTFOUND/ENODATA as not-present (no throw)', async () => {
    mx.mockRejectedValue(dnsError('ENOTFOUND'));
    txt.mockRejectedValue(dnsError('ENODATA'));
    const r = await checkEmailDns('nope.example');
    expect(r.mx.present).toBe(false);
    expect(r.spf.present).toBe(false);
    expect(r.dmarc.present).toBe(false);
    expect(r.detectedProvider).toBeNull();
  });

  it('propagates unexpected resolver errors', async () => {
    mx.mockRejectedValue(dnsError('ESERVFAIL'));
    txt.mockResolvedValue([]);
    await expect(checkEmailDns('flaky.example')).rejects.toMatchObject({ code: 'ESERVFAIL' });
  });
});
```

- [ ] **Step 2: Run → fail**

Run: `npx vitest run test/email-dns.test.ts`
Expected: FAIL (cannot resolve `../lib/email-dns`).

- [ ] **Step 3: Implement `lib/email-dns.ts`**

```ts
// ABOUTME: Generic email-DNS verification — MX/SPF/DMARC lookups + provider inference from MX.
// ABOUTME: Uses node:dns/promises (no auth). ENOTFOUND/ENODATA → "not present"; other errors propagate.

import { resolveMx, resolveTxt } from 'node:dns/promises';

export type EmailDnsResult = {
  mx: { present: boolean; records: string[] };
  spf: { present: boolean; record: string | null };
  dmarc: { present: boolean; record: string | null };
  detectedProvider: string | null;
};

// MX-host substring → friendly provider name. First match wins.
const PROVIDER_MATCHERS: { needle: string; name: string }[] = [
  { needle: 'zoho.', name: 'Zoho Mail' },
  { needle: 'aspmx.l.google.com', name: 'Google Workspace' },
  { needle: 'googlemail.com', name: 'Google Workspace' },
  { needle: 'protection.outlook.com', name: 'Microsoft 365' },
  { needle: 'outlook.com', name: 'Microsoft 365' },
  { needle: 'proton.me', name: 'Proton Mail' },
  { needle: 'protonmail.', name: 'Proton Mail' },
  { needle: 'messagingengine.com', name: 'Fastmail' },
  { needle: 'icloud.com', name: 'iCloud' },
  { needle: 'mail.me.com', name: 'iCloud' },
];

export function detectProvider(mxHosts: string[]): string | null {
  for (const host of mxHosts) {
    const h = host.toLowerCase().replace(/\.$/, '');
    for (const m of PROVIDER_MATCHERS) {
      if (h.includes(m.needle)) return m.name;
    }
  }
  return null;
}

const NOT_PRESENT_CODES = new Set(['ENOTFOUND', 'ENODATA']);
function isNotPresent(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e
    && NOT_PRESENT_CODES.has((e as { code: string }).code);
}

async function safeMx(domain: string): Promise<string[]> {
  try {
    const recs = await resolveMx(domain);
    return [...recs].sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
  } catch (e) {
    if (isNotPresent(e)) return [];
    throw e;
  }
}

async function safeTxt(name: string): Promise<string[]> {
  try {
    const recs = await resolveTxt(name);
    return recs.map((chunks) => chunks.join(''));
  } catch (e) {
    if (isNotPresent(e)) return [];
    throw e;
  }
}

export async function checkEmailDns(domain: string): Promise<EmailDnsResult> {
  const [mxHosts, txt, dmarcTxt] = await Promise.all([
    safeMx(domain),
    safeTxt(domain),
    safeTxt(`_dmarc.${domain}`),
  ]);
  const spf = txt.find((r) => r.toLowerCase().startsWith('v=spf1')) ?? null;
  const dmarc = dmarcTxt.find((r) => r.toLowerCase().startsWith('v=dmarc1')) ?? null;
  return {
    mx: { present: mxHosts.length > 0, records: mxHosts },
    spf: { present: spf !== null, record: spf },
    dmarc: { present: dmarc !== null, record: dmarc },
    detectedProvider: detectProvider(mxHosts),
  };
}
```

- [ ] **Step 4: Run → pass**

Run: `npx vitest run test/email-dns.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/email-dns.ts test/email-dns.test.ts
git commit -m "feat(email): add checkEmailDns + provider detection (node:dns)"
```

---

## Task 3: `/api/projects/[slug]/email` route

**Files:** Create `app/api/projects/[slug]/email/route.ts`.

- [ ] **Step 1: Implement the route** (verified via tsc + build; no route unit test, matching commits/errors routes)

```ts
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit**

```bash
git add "app/api/projects/[slug]/email/route.ts"
git commit -m "feat(email): add /api/projects/[slug]/email route"
```

---

## Task 4: `EmailTab` component

**Files:** Create `components/EmailTab.tsx`; Modify `app/globals.css`.

- [ ] **Step 1: Implement the component**

```tsx
// ABOUTME: Client component for the Email tab — fetches a project's email-DNS verification.

'use client';

import { useState, useEffect } from 'react';
import type { EmailDnsResult } from '@/lib/email-dns';

type EmailData = {
  domain: string;
  checks: EmailDnsResult;
  detectedProvider: string | null;
  manual: { provider: string | null; address: string | null };
};

type EmailState =
  | { kind: 'loading' }
  | { kind: 'no_domain' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; data: EmailData };

function Check({ label, present, value }: { label: string; present: boolean; value: string }) {
  return (
    <li className={`email-check ${present ? 'pass' : 'fail'}`}>
      <span className="email-check-mark" aria-hidden="true">{present ? '✓' : '✗'}</span>
      <span className="email-check-label">{label}</span>
      <span className="email-check-value">{present ? value : 'not found'}</span>
    </li>
  );
}

export function EmailTab({ slug }: { slug: string }) {
  const [state, setState] = useState<EmailState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${slug}/email`)
      .then((r) => r.json())
      .then((json: { ok: boolean; error?: string; message?: string; data?: EmailData }) => {
        if (cancelled) return;
        if (json.ok && json.data) setState({ kind: 'data', data: json.data });
        else if (json.error === 'no_domain') setState({ kind: 'no_domain' });
        else setState({ kind: 'error', message: json.message ?? json.error ?? 'Unknown error' });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: String(err) });
      });
    return () => { cancelled = true; };
  }, [slug]);

  if (state.kind === 'loading') {
    return (
      <div className="email-loading" aria-label="Loading email DNS">
        <div className="skeleton-bar" />
        <div className="skeleton-bar" />
      </div>
    );
  }

  if (state.kind === 'no_domain') {
    return (
      <p className="detail-muted">
        No domain set for this project. Add one with <code>mc project update {slug} --domain &lt;domain&gt;</code>.
      </p>
    );
  }

  if (state.kind === 'error') {
    return <p className="email-error">Failed to check email DNS: {state.message}</p>;
  }

  const { data } = state;
  const provider = data.manual.provider ?? data.detectedProvider ?? 'Unknown';
  const providerManual = Boolean(data.manual.provider);

  return (
    <div className="email-panel">
      <div className="email-summary">
        <span className="email-provider">
          Provider: {provider}{providerManual ? ' (manually set)' : data.detectedProvider ? ' (detected)' : ''}
        </span>
        {data.manual.address && <div className="email-address">Primary: {data.manual.address}</div>}
      </div>
      <ul className="email-checks">
        <Check label="MX" present={data.checks.mx.present} value={data.checks.mx.records.join(', ')} />
        <Check label="SPF" present={data.checks.spf.present} value={data.checks.spf.record ?? ''} />
        <Check label="DMARC" present={data.checks.dmarc.present} value={data.checks.dmarc.record ?? ''} />
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Append CSS to `app/globals.css`**

```css
/* Email tab (DNS verification). */
.email-summary { font-family: var(--font-mono); font-size: var(--fs-12); color: var(--ink-mute); margin-bottom: var(--space-md); }
.email-address { margin-top: var(--space-xs); }
.email-checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
.email-check { display: flex; align-items: baseline; gap: var(--space-sm); font-size: var(--fs-12); }
.email-check-mark { font-family: var(--font-mono); }
.email-check.pass .email-check-mark { color: var(--ok); }
.email-check.fail .email-check-mark { color: var(--bad); }
.email-check-label { width: 3.5rem; font-weight: 600; }
.email-check-value { color: var(--ink-mute); font-family: var(--font-mono); font-size: var(--fs-11); word-break: break-all; }
.email-error { color: var(--bad); }
```

Before committing, verify every `var(--token)` exists: `grep -nE '\-\-font-mono|--fs-12|--fs-11|--ink-mute|--space-md|--space-xs|--space-sm|--ok\b|--bad\b' app/globals.css`. For any missing token, substitute the closest token used by `.errors-*`/`.mc-run`/`.pull-ci-pill` — do NOT invent tokens. Report substitutions.

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit` → clean. Run: `npx next build` → succeeds.

- [ ] **Step 4: Commit**

```bash
git add components/EmailTab.tsx app/globals.css
git commit -m "feat(email): add EmailTab client component"
```

---

## Task 5: Mount the Email tab on the detail page

**Files:** Modify `app/p/[slug]/page.tsx`.

- [ ] **Step 1: Import EmailTab** — after the `ErrorsTab` import:

```tsx
import { EmailTab } from '@/components/EmailTab';
```

- [ ] **Step 2: Add the conditional tab BEFORE the Errors spread** — find the Errors spread `...(project.sentryProjectSlug ? [ … ] : []),` in the `TabbedPanels` tabs array, and insert immediately BEFORE it:

```tsx
              ...(project.domain ? [
                { key: 'email', label: 'Email', content: <EmailTab slug={project.slug} /> },
              ] : []),
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit` → clean. Run: `npx next build` → succeeds (route `/api/projects/[slug]/email` present).

- [ ] **Step 4: Commit**

```bash
git add "app/p/[slug]/page.tsx"
git commit -m "feat(email): show Email tab on detail page when a domain is set"
```

---

## Task 6: CLI flags + spec registry + docs

**Files:** Modify `cli/index.ts`, `cli/README.md`, `AGENTS.md`.

Note: `test/spec-sync.test.ts` enforces commander options match the `mc spec` registry — update both.

- [ ] **Step 1: Add the options to both commands** — in `cli/index.ts`, in BOTH the `project.command('add')` and `project.command('update')` option chains, after the `.option('--sentry-project <slug>')` line, add:

```ts
  .option('--email-provider <name>')
  .option('--email-address <addr>')
```

- [ ] **Step 2: Map in `coerceProjectFields`** — after the `sentryProject` mapping line:

```ts
  if (opts.emailProvider !== undefined) out.emailProvider = String(opts.emailProvider) || null;
  if (opts.emailAddress !== undefined) out.emailAddress = String(opts.emailAddress) || null;
```

- [ ] **Step 3: Spec registry** — append `'--email-provider', '--email-address'` to the END of the `options` arrays of BOTH the `project add` and `project update` registry entries (after `'--sentry-project'`).

- [ ] **Step 4: Docs** — in `cli/README.md` and `AGENTS.md`, add `--email-provider` and `--email-address` to the `mc project add` flag list (the `update` lines use the "any add flag" shorthand — leave them).

- [ ] **Step 5: Verify spec-sync + typecheck**

Run: `npx vitest run test/spec-sync.test.ts` → PASS.
Run: `npx tsc --noEmit` → clean.

- [ ] **Step 6: Smoke-test (cleans up)**

Run: `npm run cli -- project add --name "Email Smoke" --category internal --email-provider "Self-hosted" --email-address "ops@smoke.test" --json`
Run: `npm run cli -- project get email-smoke --json` → confirm `"emailProvider":"Self-hosted"` and `"emailAddress":"ops@smoke.test"`.
Cleanup: `npm run cli -- project rm email-smoke --yes` (use the actual slug from the add output if different).

- [ ] **Step 7: Commit**

```bash
git add cli/index.ts cli/README.md AGENTS.md
git commit -m "feat(email): add --email-provider/--email-address CLI flags"
```

---

## Task 7: Full verification

**Files:** none.

- [ ] **Step 1: Full gate**

Run: `npx tsc --noEmit && npx eslint lib components app cli test && npx next build && npm test`
Expected: tsc clean; eslint clean on the feature dirs (the full `npm run lint` may choke on stray `docs/dist`/`docs/.vercel` build artifacts — that's unrelated; scope eslint to the dirs above); build succeeds with `/api/projects/[slug]/email`; all tests pass including the 2 new files (`email-dns.test.ts` = 4, `email-fields.test.ts` = 1).

- [ ] **Step 2: Browser dogfood (auth-gated)**

`npm run dev`, sign in, open `/p/<slug>` for a project that has a real `domain`. Confirm:
- the **Email** tab appears (and is absent for a project with no domain),
- MX/SPF/DMARC render with ✓/✗ and record values, and the provider line shows the detected provider,
- setting `mc project update <slug> --email-provider "X" --email-address "y@z"` makes the header show the manual provider "(manually set)" + the primary address.

---

## Self-Review (completed during authoring)

- **Spec coverage:** columns+migration+mutations (T1), `checkEmailDns`/`detectProvider` (T2), route (T3), `EmailTab` (T4), conditional tab placed before Errors (T5), CLI flags + docs (T6), verification incl. dogfood (T7). Every spec "Files touched" row maps to a task.
- **Placeholder scan:** complete code in every step; commands have expected output; the only `NNNN` is the drizzle-generated migration name, and the CSS token note is an explicit grep-and-substitute instruction (not a vague directive).
- **Type consistency:** `EmailDnsResult` (T2) is consumed by the route (T3) and imported `import type` by `EmailTab` (T4); the route's returned shape `{ domain, checks, detectedProvider, manual:{provider,address} }` is exactly the `EmailData` type `EmailTab` declares; `emailProvider`/`emailAddress` names are identical across schema (T1), mutations (T1), route `manual` (T3), CLI map + registry (T6); the detail-page condition uses `project.domain` (T5), matching the route's `no_domain` guard (T3).

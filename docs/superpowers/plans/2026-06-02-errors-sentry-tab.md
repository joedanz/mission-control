# Errors (Sentry) Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only **Errors** tab to the project detail page that lists a project's live unresolved Sentry issues, mirroring the existing GitHub Commits/PRs integration.

**Architecture:** New `sentryProjectSlug` column on `projects` (org from `SENTRY_ORG` env); a `fetch`-based `lib/sentry-api.ts` client (Bearer `SENTRY_AUTH_TOKEN`); an `/api/projects/[slug]/errors` route with the standard `{ok,error,data}` envelope; a `'use client'` `ErrorsTab`; and a conditional tab in `app/p/[slug]/page.tsx`. Operator maps a project via `mc project update --sentry-project <slug>`.

**Tech Stack:** Next.js (App Router, RSC + client islands), TypeScript, Drizzle/Neon, Vitest (node + real Neon DB; API client tested by stubbing `globalThis.fetch`).

**Branch:** `feat/errors-sentry-tab` (already created; the spec is committed there).

**Spec:** `docs/superpowers/specs/2026-06-02-errors-sentry-tab-design.md`

---

## Conventions for this plan
- Typecheck: `npx tsc --noEmit` (Expected: no output, exit 0).
- Tests: `npm test` runs the whole suite; single file: `npx vitest run test/<file>.test.ts`.
- Tests hit the **real Neon dev DB** (`DATABASE_URL` from `.env.local`); they run serially.
- **Git:** stage with explicit paths — do NOT use `git add -A`/`git add .` (there are unrelated uncommitted docs changes in the tree). Commit per task.
- There is **no component/jsdom test harness** — React components are verified via `tsc` + `next build` + browser dogfood, not unit tests. Do not add jsdom tests.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `lib/db/schema.ts` | add `sentryProjectSlug` to `projects` | Modify |
| `migrations/0006_*.sql` | drizzle-generated `ADD COLUMN` | New (generated) |
| `lib/mutations.ts` | accept `sentryProjectSlug` in create/update | Modify |
| `lib/sentry.ts` | `sentryProjectRef()` mapping helper | New |
| `lib/sentry-api.ts` | `sentryFetch`, `listUnresolvedIssues`, types, `SentryApiError` | New |
| `app/api/projects/[slug]/errors/route.ts` | Errors API route | New |
| `components/ErrorsTab.tsx` | client Errors tab | New |
| `app/p/[slug]/page.tsx` | conditional `Errors` tab | Modify |
| `cli/index.ts` | `--sentry-project` flag + field map + spec registry | Modify |
| `cli/README.md`, `AGENTS.md` | document `--sentry-project` | Modify |
| `.env.example` | `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_BASE_URL` | Modify |
| `test/sentry.test.ts` | unit tests for `sentryProjectRef` | New |
| `test/sentry-api.test.ts` | fetch-mocked unit tests for the client | New |
| `test/sentry-project-field.test.ts` | DB test: the column persists | New |

---

## Task 1: `sentryProjectSlug` column + migration + mutation wiring

**Files:**
- Modify: `lib/db/schema.ts`, `lib/mutations.ts`
- Create: `migrations/0006_*.sql` (generated), `test/sentry-project-field.test.ts`

- [ ] **Step 1: Write the failing DB test**

Create `test/sentry-project-field.test.ts`:

```ts
// ABOUTME: Verifies the projects.sentryProjectSlug column persists via createProject/updateProject.

import { describe, it, expect, afterAll } from 'vitest';
import { createProject, updateProject, deleteProject } from '../lib/mutations';
import { getProjectBySlug } from '../lib/queries';

const created: string[] = [];
afterAll(async () => { for (const id of created) await deleteProject(id); });

describe('projects.sentryProjectSlug', () => {
  it('persists through create + update + clear', async () => {
    const p = await createProject({
      name: `Sentry Field Test ${Date.now()}`,
      category: 'internal',
      status: 'prelaunch',
      sentryProjectSlug: 'my-sentry-proj',
    });
    created.push(p.id);
    expect((await getProjectBySlug(p.slug))?.sentryProjectSlug).toBe('my-sentry-proj');

    await updateProject(p.id, { sentryProjectSlug: 'renamed-proj' });
    expect((await getProjectBySlug(p.slug))?.sentryProjectSlug).toBe('renamed-proj');

    await updateProject(p.id, { sentryProjectSlug: null });
    expect((await getProjectBySlug(p.slug))?.sentryProjectSlug).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/sentry-project-field.test.ts`
Expected: FAIL — TypeScript error that `sentryProjectSlug` is not a property of `ProjectInput`/`Project` (the column and types don't exist yet).

- [ ] **Step 3: Add the column to the schema**

In `lib/db/schema.ts`, inside the `projects` table column list, add after the `liveUrl` line (`liveUrl: text('live_url'),`):

```ts
    sentryProjectSlug: text('sentry_project_slug'), // nullable; null = project has no Errors tab
```

- [ ] **Step 4: Generate + apply the migration**

Run: `npm run db:generate`
Expected: a new file `migrations/0006_<random>.sql` containing `ALTER TABLE "projects" ADD COLUMN "sentry_project_slug" text;`. Open it and confirm it is ONLY that `ADD COLUMN` (no unexpected statements; table-level grants already cover the new column).

Run: `npm run db:migrate`
Expected: the migration applies to the Neon dev DB without error.

- [ ] **Step 5: Wire `sentryProjectSlug` into mutations**

In `lib/mutations.ts`:

Add to the `ProjectInput` type (after `liveUrl?: string | null;`):
```ts
  sentryProjectSlug?: string | null;
```

In `createProject`'s `.values({ … })` (after `liveUrl: input.liveUrl ?? null,`):
```ts
      sentryProjectSlug: input.sentryProjectSlug ?? null,
```

In `updateProject`'s whitelist (after the `liveUrl` line):
```ts
  if (input.sentryProjectSlug !== undefined) set.sentryProjectSlug = input.sentryProjectSlug;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/sentry-project-field.test.ts`
Expected: PASS (1 test).

- [ ] **Step 7: Typecheck + commit**

Run: `npx tsc --noEmit` → clean.

```bash
git add lib/db/schema.ts lib/mutations.ts migrations/ test/sentry-project-field.test.ts
git commit -m "feat(projects): add sentryProjectSlug column + mutation wiring"
```

---

## Task 2: `lib/sentry.ts` — `sentryProjectRef` mapping helper

**Files:**
- Create: `lib/sentry.ts`, `test/sentry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/sentry.test.ts`:

```ts
// ABOUTME: Unit tests for sentryProjectRef — maps a project + SENTRY_ORG env to a Sentry ref.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sentryProjectRef } from '../lib/sentry';

describe('sentryProjectRef', () => {
  const saved = process.env.SENTRY_ORG;
  afterEach(() => { if (saved === undefined) delete process.env.SENTRY_ORG; else process.env.SENTRY_ORG = saved; });

  it('returns null when no slug', () => {
    process.env.SENTRY_ORG = 'acme';
    expect(sentryProjectRef({ sentryProjectSlug: null })).toBeNull();
  });

  it('returns null when SENTRY_ORG is unset', () => {
    delete process.env.SENTRY_ORG;
    expect(sentryProjectRef({ sentryProjectSlug: 'web' })).toBeNull();
  });

  it('returns {org, project} when both present', () => {
    process.env.SENTRY_ORG = 'acme';
    expect(sentryProjectRef({ sentryProjectSlug: 'web' })).toEqual({ org: 'acme', project: 'web' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/sentry.test.ts`
Expected: FAIL — cannot resolve `../lib/sentry`.

- [ ] **Step 3: Implement `lib/sentry.ts`**

```ts
// ABOUTME: Maps a project (sentryProjectSlug) + SENTRY_ORG env to a Sentry API ref. The parseGitHubRepo analog.

export type SentryRef = { org: string; project: string };

/** A project's Sentry ref, or null when unmapped (no slug, or no SENTRY_ORG configured). */
export function sentryProjectRef(p: { sentryProjectSlug: string | null }): SentryRef | null {
  const org = process.env.SENTRY_ORG;
  if (!org || !p.sentryProjectSlug) return null;
  return { org, project: p.sentryProjectSlug };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/sentry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/sentry.ts test/sentry.test.ts
git commit -m "feat(sentry): add sentryProjectRef mapping helper"
```

---

## Task 3: `lib/sentry-api.ts` — Sentry REST client

**Files:**
- Create: `lib/sentry-api.ts`, `test/sentry-api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/sentry-api.test.ts`:

```ts
// ABOUTME: Unit tests for lib/sentry-api — mocks globalThis.fetch; no network calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listUnresolvedIssues, SentryApiError } from '../lib/sentry-api';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function stubResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const REF = { org: 'acme', project: 'web' };

const RAW_ISSUE = {
  id: '123',
  shortId: 'WEB-1',
  title: 'TypeError: undefined is not a function',
  culprit: 'app/page.tsx in render',
  level: 'error',
  count: '1204',
  userCount: 89,
  lastSeen: '2026-06-02T10:00:00Z',
  permalink: 'https://acme.sentry.io/issues/123/',
};

describe('listUnresolvedIssues', () => {
  let savedFetch: FetchLike;
  const savedToken = process.env.SENTRY_AUTH_TOKEN;
  const savedBase = process.env.SENTRY_BASE_URL;

  beforeEach(() => {
    savedFetch = globalThis.fetch as FetchLike;
    process.env.SENTRY_AUTH_TOKEN = 'tok_test';
    delete process.env.SENTRY_BASE_URL; // exercise the default base
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.SENTRY_AUTH_TOKEN; else process.env.SENTRY_AUTH_TOKEN = savedToken;
    if (savedBase === undefined) delete process.env.SENTRY_BASE_URL; else process.env.SENTRY_BASE_URL = savedBase;
  });

  it('calls the right URL with the bearer token and maps issues', async () => {
    const spy = vi.fn().mockResolvedValue(stubResponse([RAW_ISSUE]));
    globalThis.fetch = spy as unknown as typeof fetch;

    const issues = await listUnresolvedIssues(REF, { statsPeriod: '24h', limit: 25 });

    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe(
      'https://sentry.io/api/0/projects/acme/web/issues/?query=is%3Aunresolved&statsPeriod=24h&limit=25',
    );
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok_test');
    expect(issues).toEqual([{
      id: '123',
      shortId: 'WEB-1',
      title: 'TypeError: undefined is not a function',
      culprit: 'app/page.tsx in render',
      level: 'error',
      count: 1204,        // string → number
      userCount: 89,
      lastSeen: '2026-06-02T10:00:00Z',
      permalink: 'https://acme.sentry.io/issues/123/',
    }]);
  });

  it('throws SentryApiError with status on non-2xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(stubResponse({ detail: 'nope' }, 403)) as unknown as typeof fetch;
    await expect(listUnresolvedIssues(REF)).rejects.toMatchObject({ name: 'SentryApiError', status: 403 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/sentry-api.test.ts`
Expected: FAIL — cannot resolve `../lib/sentry-api`.

- [ ] **Step 3: Implement `lib/sentry-api.ts`**

```ts
// ABOUTME: Sentry REST client for the web UI — fetches a project's unresolved issues via SENTRY_AUTH_TOKEN.
// ABOUTME: Uses fetch (no SDK), so it works on Vercel. Mirrors lib/github-api.ts.

import type { SentryRef } from './sentry';

export type SentryIssue = {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string; // error | warning | info | fatal | debug | sample
  count: number; // event count in the window (Sentry returns a string)
  userCount: number;
  lastSeen: string; // ISO
  permalink: string;
};

export type ErrorsSummary = { unresolvedShown: number; events24h: number; window: '24h' };

export class SentryApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'SentryApiError';
  }
}

function sentryBase(): string {
  return process.env.SENTRY_BASE_URL || 'https://sentry.io';
}

async function sentryFetch(path: string): Promise<unknown> {
  const res = await fetch(`${sentryBase()}${path}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${process.env.SENTRY_AUTH_TOKEN}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SentryApiError(`Sentry API ${res.status}: ${body.slice(0, 200)}`, res.status);
  }
  return res.json();
}

type RawIssue = {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  count: string;
  userCount: number;
  lastSeen: string;
  permalink: string;
};

export async function listUnresolvedIssues(
  ref: SentryRef,
  opts: { statsPeriod?: string; limit?: number } = {},
): Promise<SentryIssue[]> {
  const qs = new URLSearchParams({
    query: 'is:unresolved',
    statsPeriod: opts.statsPeriod ?? '24h',
    limit: String(opts.limit ?? 25),
  });
  const data = (await sentryFetch(
    `/api/0/projects/${ref.org}/${ref.project}/issues/?${qs.toString()}`,
  )) as RawIssue[];

  return data.map((i) => ({
    id: i.id,
    shortId: i.shortId,
    title: i.title,
    culprit: i.culprit,
    level: i.level,
    count: Number(i.count) || 0,
    userCount: i.userCount,
    lastSeen: i.lastSeen,
    permalink: i.permalink,
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/sentry-api.test.ts`
Expected: PASS (2 tests). If the URL assertion fails, check the `URLSearchParams` encoding (`is:unresolved` → `is%3Aunresolved`) matches the expected string exactly.

- [ ] **Step 5: Commit**

```bash
git add lib/sentry-api.ts test/sentry-api.test.ts
git commit -m "feat(sentry): add sentry-api client (listUnresolvedIssues)"
```

---

## Task 4: `/api/projects/[slug]/errors` route

**Files:**
- Create: `app/api/projects/[slug]/errors/route.ts`

- [ ] **Step 1: Implement the route**

(No unit test — route behavior is verified via `tsc` + `next build` + dogfood, matching the repo's commits/pulls routes which have no route tests.)

Create `app/api/projects/[slug]/errors/route.ts`:

```ts
// ABOUTME: GET unresolved Sentry issues for a project. Auth-gated; requires SENTRY_ORG + SENTRY_AUTH_TOKEN.

import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getProjectBySlug } from '@/lib/queries';
import { sentryProjectRef } from '@/lib/sentry';
import { listUnresolvedIssues, SentryApiError, type ErrorsSummary } from '@/lib/sentry-api';

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

  const ref = sentryProjectRef(project);
  if (!ref) {
    return Response.json({ ok: false, error: 'no_sentry_project' }, { status: 422 });
  }

  if (!process.env.SENTRY_AUTH_TOKEN) {
    return Response.json({ ok: false, error: 'sentry_token_missing' }, { status: 503 });
  }

  try {
    const issues = await listUnresolvedIssues(ref, { statsPeriod: '24h', limit: 25 });
    const summary: ErrorsSummary = {
      unresolvedShown: issues.length,
      events24h: issues.reduce((n, i) => n + i.count, 0),
      window: '24h',
    };
    return Response.json({ ok: true, data: { issues, summary } });
  } catch (e) {
    if (e instanceof SentryApiError) {
      return Response.json(
        { ok: false, error: 'sentry_api_error', message: e.message },
        { status: e.status ?? 502 },
      );
    }
    throw e;
  }
}
```

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit` → clean.
Run: `npx next build` → succeeds; the route `/api/projects/[slug]/errors` appears in the output.

- [ ] **Step 3: Commit**

```bash
git add "app/api/projects/[slug]/errors/route.ts"
git commit -m "feat(sentry): add /api/projects/[slug]/errors route"
```

---

## Task 5: `ErrorsTab` component

**Files:**
- Create: `components/ErrorsTab.tsx`

- [ ] **Step 1: Implement the component**

(No unit test — no component-test harness; verified via `tsc` + `next build` + dogfood, like `CommitsTab`.)

Create `components/ErrorsTab.tsx`:

```tsx
// ABOUTME: Client component for the Errors tab — fetches a project's unresolved Sentry issues.

'use client';

import { useState, useEffect } from 'react';
import { relativeTime } from '@/lib/ui';
import type { SentryIssue, ErrorsSummary } from '@/lib/sentry-api';

type ErrorsState =
  | { kind: 'loading' }
  | { kind: 'no_project' }
  | { kind: 'no_token' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; issues: SentryIssue[]; summary: ErrorsSummary };

export function ErrorsTab({ slug }: { slug: string }) {
  const [state, setState] = useState<ErrorsState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${slug}/errors`)
      .then((r) => r.json())
      .then((json: { ok: boolean; error?: string; message?: string; data?: { issues: SentryIssue[]; summary: ErrorsSummary } }) => {
        if (cancelled) return;
        if (json.ok && json.data) {
          setState({ kind: 'data', issues: json.data.issues, summary: json.data.summary });
        } else if (json.error === 'no_sentry_project') {
          setState({ kind: 'no_project' });
        } else if (json.error === 'sentry_token_missing') {
          setState({ kind: 'no_token' });
        } else {
          setState({ kind: 'error', message: json.message ?? json.error ?? 'Unknown error' });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: String(err) });
      });
    return () => { cancelled = true; };
  }, [slug]);

  if (state.kind === 'loading') {
    return (
      <div className="errors-loading" aria-label="Loading errors">
        <div className="skeleton-bar" />
        <div className="skeleton-bar" />
        <div className="skeleton-bar" />
      </div>
    );
  }

  if (state.kind === 'no_project') {
    return (
      <p className="detail-muted">
        No Sentry project linked. Set one with <code>mc project update {slug} --sentry-project &lt;slug&gt;</code>.
      </p>
    );
  }

  if (state.kind === 'no_token') {
    return (
      <p className="detail-muted">
        Add <code>SENTRY_AUTH_TOKEN</code> and <code>SENTRY_ORG</code> to your environment to view errors.
      </p>
    );
  }

  if (state.kind === 'error') {
    return <p className="errors-error">Failed to load errors: {state.message}</p>;
  }

  if (state.issues.length === 0) {
    return <p className="detail-muted">No unresolved issues. 🎉</p>;
  }

  return (
    <div className="errors-panel">
      <div className="errors-summary">
        {state.summary.unresolvedShown} unresolved (top 25) · {state.summary.events24h.toLocaleString()} events (24h)
      </div>
      <ul className="errors-list">
        {state.issues.map((i) => (
          <li className="errors-row" key={i.id}>
            <a className="errors-link" href={i.permalink} target="_blank" rel="noreferrer">
              <span className={`errors-level ${i.level}`} aria-hidden="true" />
              <span className="errors-title">{i.title}</span>
              {i.culprit && <span className="errors-culprit">{i.culprit}</span>}
              <span className="errors-meta">
                {i.count.toLocaleString()} ev · {i.userCount} users · {relativeTime(i.lastSeen)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Add minimal styles**

Append to the end of `app/globals.css`:

```css
/* Errors tab (Sentry unresolved issues). */
.errors-summary { font-family: var(--font-mono); font-size: var(--fs-12); color: var(--ink-mute); margin-bottom: var(--space-md); }
.errors-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-xs); }
.errors-link { display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-sm); border: 1px solid var(--line); border-radius: var(--radius-sm); text-decoration: none; color: inherit; }
.errors-link:hover { border-color: var(--line-strong); }
.errors-level { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-mute); flex: none; }
.errors-level.error, .errors-level.fatal { background: #e5484d; }
.errors-level.warning { background: #f5a623; }
.errors-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.errors-culprit { color: var(--ink-mute); font-size: var(--fs-12); }
.errors-meta { color: var(--ink-mute); font-family: var(--font-mono); font-size: var(--fs-11); white-space: nowrap; }
.errors-error { color: #e5484d; }
```

(If any `var(--*)` token used above is not defined in `app/globals.css`, grep for the nearest existing token — e.g. reuse whatever `.mc-run`/`.commit-row` use — and substitute. Do not invent new design tokens.)

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit` → clean.
Run: `npx next build` → succeeds.

- [ ] **Step 4: Commit**

```bash
git add components/ErrorsTab.tsx app/globals.css
git commit -m "feat(sentry): add ErrorsTab client component"
```

---

## Task 6: Mount the Errors tab on the project detail page

**Files:**
- Modify: `app/p/[slug]/page.tsx`

- [ ] **Step 1: Import ErrorsTab**

Add near the other component imports (after the `PullsTab` import):

```tsx
import { ErrorsTab } from '@/components/ErrorsTab';
```

- [ ] **Step 2: Add the conditional tab**

In the `TabbedPanels` `tabs={[…]}` array, the GitHub tabs are appended like this:

```tsx
              ...(githubRepo ? [
                { key: 'commits', label: 'Commits', content: <CommitsTab slug={project.slug} /> },
                { key: 'prs', label: 'PRs', content: <PullsTab slug={project.slug} /> },
              ] : []),
```

Immediately AFTER that spread (still inside the array), add:

```tsx
              ...(project.sentryProjectSlug ? [
                { key: 'errors', label: 'Errors', content: <ErrorsTab slug={project.slug} /> },
              ] : []),
```

- [ ] **Step 3: Typecheck + build**

Run: `npx tsc --noEmit` → clean.
Run: `npx next build` → succeeds.

- [ ] **Step 4: Commit**

```bash
git add "app/p/[slug]/page.tsx"
git commit -m "feat(sentry): show Errors tab on detail page when a Sentry project is linked"
```

---

## Task 7: CLI flag, spec registry, and config docs

**Files:**
- Modify: `cli/index.ts`, `cli/README.md`, `AGENTS.md`, `.env.example`

Note: `test/spec-sync.test.ts` enforces that the commander command options match the `mc spec` registry, so both must be updated together.

- [ ] **Step 1: Add the `--sentry-project` option to both commands**

In `cli/index.ts`, in the `project.command('add')` option chain, add after `.option('--live-url <url>')`:

```ts
  .option('--sentry-project <slug>')
```

In the `project.command('update')` option chain, add after its `.option('--live-url <url>')`:

```ts
  .option('--sentry-project <slug>')
```

- [ ] **Step 2: Map the flag in `coerceProjectFields`**

In `coerceProjectFields`, add after the `liveUrl` line:

```ts
  if (opts.sentryProject !== undefined) out.sentryProjectSlug = String(opts.sentryProject) || null;
```

- [ ] **Step 3: Add `--sentry-project` to the spec registry**

In the spec registry array, append `'--sentry-project'` to the `options` arrays of BOTH the `project add` and `project update` entries:

```ts
  { name: 'project add', readonly: false, summary: 'Create a project', required: ['--name', '--category'], options: ['--status', '--accent', '--domain', '--tech', '--repo-path', '--repo-url', '--live-url', '--priority', '--notes', '--sentry-project'] },
  { name: 'project update', readonly: false, summary: 'Update a project (only provided flags change)', args: ['<slug>'], options: ['--name', '--category', '--status', '--accent', '--domain', '--tech', '--repo-path', '--repo-url', '--live-url', '--priority', '--notes', '--sentry-project'] },
```

- [ ] **Step 4: Update docs**

In `cli/README.md`, add `--sentry-project` to the `project add` and `project update` option lists (the bracketed flag lists). In `AGENTS.md`, do the same in the `mc project add` / `mc project update` lines of the CLI reference block.

In `.env.example`, add after the `GITHUB_TOKEN=` line:

```bash

# Sentry — powers the project "Errors" tab (live unresolved issues).
# Token needs the project:read scope. SENTRY_BASE_URL is optional (region/self-hosted).
SENTRY_AUTH_TOKEN=
SENTRY_ORG=
SENTRY_BASE_URL=https://sentry.io
```

- [ ] **Step 5: Verify spec-sync + typecheck**

Run: `npx vitest run test/spec-sync.test.ts`
Expected: PASS (the commander options now match the registry).

Run: `npx tsc --noEmit` → clean.

- [ ] **Step 6: Smoke-test the flag end-to-end (manual)**

Run: `npm run cli -- project add --name "Sentry Smoke" --category internal --sentry-project smoke-proj --json`
Then: `npm run cli -- project get sentry-smoke --json` → confirm `sentryProjectSlug: "smoke-proj"` in the output.
Cleanup: `npm run cli -- project rm sentry-smoke --yes`

- [ ] **Step 7: Commit**

```bash
git add cli/index.ts cli/README.md AGENTS.md .env.example
git commit -m "feat(sentry): add --sentry-project CLI flag + document SENTRY_* env"
```

---

## Task 8: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole gate**

Run: `npx tsc --noEmit && npm run lint && npx next build && npm test`
Expected: tsc clean; lint clean (if eslint crashes, it is the unrelated `docs/dist`/`docs/.vercel` build-artifact issue — confirm by running `npx eslint lib components app/api "app/p"` scoped to this slice's files, which must be clean); build succeeds; all tests pass (including the 3 new test files).

- [ ] **Step 2: Browser dogfood (auth-gated)**

Set `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` in `.env.local`, link a real project (`npm run cli -- project update <slug> --sentry-project <real-sentry-project>`), run `npm run dev`, sign in, open `/p/<slug>`, and confirm:
- the **Errors** tab appears (and does NOT appear for a project with no `sentryProjectSlug`),
- it lists unresolved issues with the summary header, each linking to Sentry,
- the `no_token` state shows when the token is unset.

---

## Self-Review (completed during authoring)

- **Spec coverage:** schema+migration+mutation (T1), `sentryProjectRef` (T2), `sentry-api` client (T3), route (T4), `ErrorsTab` (T5), conditional tab (T6), CLI flag + env docs (T7), verification incl. dogfood (T8). Every spec "Files touched" row maps to a task.
- **Placeholder scan:** every code step has complete code; commands have expected output; the only `*` is the drizzle-generated migration filename (legitimately unknown until generated) and the CSS token fallback note (explicit instruction to grep + substitute, not a vague "handle styling").
- **Type consistency:** `SentryRef` (T2) is consumed by `listUnresolvedIssues(ref: SentryRef)` (T3) and `sentryProjectRef` returns it; `SentryIssue`/`ErrorsSummary` defined in T3 are imported by the route (T4) and `ErrorsTab` (T5) via `import type`; the route returns `{ issues, summary }` and `ErrorsTab` reads exactly those; `sentryProjectSlug` is the property name in schema (T1), mutations (T1), `sentryProjectRef` (T2), the route via `sentryProjectRef(project)` (T4), the page condition (T6), and the CLI map (T7).

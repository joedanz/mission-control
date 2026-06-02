# Errors (Sentry) tab — live unresolved issues per project

**Date:** 2026-06-02
**Status:** Approved (design)
**Scope:** One slice. The first of the live integration tabs. Mirrors the existing GitHub Commits/PRs integration. Later slices (Email/Zoho, Stripe, and the Integrations-tab reshape) get their own spec → plan → build cycles and are NOT covered here.

## Problem

The project detail page has live, per-project data tabs for GitHub (Commits, PRs) but nothing for error monitoring. Sentry error status currently appears only as a tri-state row ("needed/pending/done") in the Integrations tab — not the actual live errors. We want an **Errors** tab that shows a project's real unresolved Sentry issues, following the same pattern the GitHub tabs already established.

## Goal

A read-only **Errors** tab on the project detail page that lists a project's recent unresolved Sentry issues with a one-line summary, visible only for projects mapped to a Sentry project.

## Decisions (from brainstorming)

- **Project→Sentry mapping:** a new nullable `sentryProjectSlug` column on `projects`; the Sentry org comes from a single `SENTRY_ORG` env (one org for all projects). Set via `mc project update --sentry-project <slug>`.
- **Auth:** single `SENTRY_AUTH_TOKEN` env (Bearer), mirroring `GITHUB_TOKEN`. Optional `SENTRY_BASE_URL` (default `https://sentry.io`) for region/self-hosted.
- **Tab content (v1):** a summary header (unresolved shown + 24h event volume) + a list of recent unresolved issues, each linking to its Sentry permalink. **Read-only** — no resolve/ignore actions.
- **Integrations tab:** left as-is this slice (it keeps its Sentry status row). The reshape into Email/Errors/Stripe tabs happens as those slices land.

## Architecture

A direct mirror of the GitHub integration (`lib/github-api.ts` → `app/api/projects/[slug]/commits/route.ts` → `components/CommitsTab.tsx` → conditional tab in `app/p/[slug]/page.tsx`). All `fetch`-based (no SDK), so it runs on Vercel. The detail page stays a Server Component; the tab is a client island that fetches the route.

## Components

### 1. Data model + migration
- Add to the `projects` table in `lib/db/schema.ts`:
  ```ts
  sentryProjectSlug: text('sentry_project_slug'), // nullable; null = no Errors tab
  ```
- Generate the migration: `npm run db:generate` (drizzle-kit) → a new file under `migrations/`. It is a plain `ALTER TABLE projects ADD COLUMN sentry_project_slug text;`.
- **Grants:** table-level grants on `projects` cover new columns in Postgres (no column-level grants are used), so no new `GRANT` is required. Verify the generated migration contains only the `ADD COLUMN` (no stray grant needed) before applying.
- `getProjectBySlug` uses `select()` (all columns), so `sentryProjectSlug` flows to the detail page and `mc project get` automatically — no query change.

### 2. `lib/sentry.ts` (mapping helper — the `parseGitHubRepo` analog)
```ts
export type SentryRef = { org: string; project: string };

/** A project's Sentry ref, or null when unmapped (no slug, or no SENTRY_ORG configured). */
export function sentryProjectRef(p: { sentryProjectSlug: string | null }): SentryRef | null {
  const org = process.env.SENTRY_ORG;
  if (!org || !p.sentryProjectSlug) return null;
  return { org, project: p.sentryProjectSlug };
}
```

### 3. `lib/sentry-api.ts` (REST client — the `lib/github-api.ts` analog)
- `SentryApiError extends Error` with optional `status`.
- `sentryFetch(path)` — `GET {SENTRY_BASE_URL||'https://sentry.io'}{path}` with `Authorization: Bearer ${SENTRY_AUTH_TOKEN}`, `Accept: application/json`; throws `SentryApiError` on non-2xx (message includes status + truncated body).
- Types:
  ```ts
  export type SentryIssue = {
    id: string;
    shortId: string;
    title: string;
    culprit: string;
    level: string;       // error | warning | info | fatal | debug | sample
    count: number;       // event count in window (Sentry returns a string; parsed to number)
    userCount: number;
    lastSeen: string;    // ISO
    permalink: string;
  };
  export type ErrorsSummary = { unresolvedShown: number; events24h: number; window: '24h' };
  ```
- `listUnresolvedIssues(ref: SentryRef, opts?: { statsPeriod?: string; limit?: number }): Promise<SentryIssue[]>`
  - Calls `GET /api/0/projects/{ref.org}/{ref.project}/issues/?query=is:unresolved&statsPeriod={statsPeriod||'24h'}&limit={limit||25}`.
  - Maps the raw array (`id, shortId, title, culprit, level, count, userCount, lastSeen, permalink`) → `SentryIssue[]`, coercing `count` via `Number(raw.count)`.

### 4. `app/api/projects/[slug]/errors/route.ts` (the commits-route analog)
- `runtime='nodejs'`, `dynamic='force-dynamic'`.
- `requireAllowedUser()` → 401 `{ok:false,error:'unauthorized'}`.
- `getProjectBySlug(slug)` → 404 `{ok:false,error:'not_found'}`.
- `sentryProjectRef(project)` null → 422 `{ok:false,error:'no_sentry_project'}`.
- `!process.env.SENTRY_AUTH_TOKEN` → 503 `{ok:false,error:'sentry_token_missing'}`.
- else: `const issues = await listUnresolvedIssues(ref)`, build `summary = { unresolvedShown: issues.length, events24h: issues.reduce((n,i)=>n+i.count,0), window:'24h' }`, return `{ok:true, data:{ issues, summary }}`.
- `catch (SentryApiError)` → `{ok:false, error:'sentry_api_error', message}` with `status ?? 502`.

### 5. `components/ErrorsTab.tsx` (the `CommitsTab` analog)
- `'use client'`. On mount, `fetch('/api/projects/${slug}/errors')`; discriminated state: `loading | no_project | no_token | error | data` (maps `no_sentry_project`→`no_project`, `sentry_token_missing`→`no_token`, like CommitsTab).
- States:
  - `no_project`: "No Sentry project linked. Set one with `mc project update <slug> --sentry-project <slug>`."
  - `no_token`: "Add `SENTRY_AUTH_TOKEN` (+ `SENTRY_ORG`) to view errors." with a short hint.
  - `error`: "Failed to load errors: {message}".
  - `data` empty: "No unresolved issues. 🎉"
  - `data`: summary header (`{unresolvedShown} unresolved (top 25) · {events24h.toLocaleString()} events (24h)`) + an "open in Sentry" link (`{SENTRY_BASE_URL||'https://sentry.io'}/organizations/{org}/projects/{slug}/` — built server-side and returned, OR omit if it requires the org on the client; simplest: each issue links via its `permalink`, and the header omits a project-level link in v1). Then a list; each row: level dot, `title`, `culprit` (muted), `{count} ev · {userCount} users · {relativeTime(lastSeen)}`, linking to `issue.permalink` (new tab).

  Layout target:
  ```
  Errors
  ─────────────────────────────────────────────────────────
  12 unresolved (top 25) · 3,410 events (24h)
    ● error    TypeError: undefined is not a function   1,204 ev · 89 users · 2h ago
    ● warning  Slow query: getDashboard                   311 ev · 40 users · 5h ago
    …
  ```
  Reuse existing `relativeTime` from `lib/ui`. Reuse existing list/skeleton CSS conventions from the commits panel where they fit; add minimal `errors-*` classes to `app/globals.css` only as needed.

### 6. Detail page — `app/p/[slug]/page.tsx`
- Add to the `TabbedPanels` tabs array, conditional on the mapping (mirrors `githubRepo ? [...] : []`):
  ```tsx
  ...(project.sentryProjectSlug ? [
    { key: 'errors', label: 'Errors', content: <ErrorsTab slug={project.slug} /> },
  ] : []),
  ```
- Import `ErrorsTab`. Nothing else on the page changes (Integrations tab stays).

### 7. CLI + config
- `cli/index.ts`:
  - Add `.option('--sentry-project <slug>')` to both `project add` and `project update` commands.
  - In `coerceProjectFields(opts)`, add: `if (opts.sentryProject !== undefined) out.sentryProjectSlug = String(opts.sentryProject) || null;`
  - Add `--sentry-project` to the `mc spec` options arrays for `project add` and `project update` (the registry near line 307–308).
- `lib/mutations.ts`:
  - Add `sentryProjectSlug?: string | null;` to both `ProjectInput` and `ProjectUpdate`.
  - In `createProject`, set `sentryProjectSlug: input.sentryProjectSlug ?? null`.
  - In `updateProject`, add `if (input.sentryProjectSlug !== undefined) set.sentryProjectSlug = input.sentryProjectSlug;`
- `cli/README.md` + `AGENTS.md` CLI block: add `--sentry-project` to the `project add` / `project update` option lists.
- `.env.example`: document `SENTRY_AUTH_TOKEN` (Sentry auth token, scope `project:read`), `SENTRY_ORG` (org slug), and optional `SENTRY_BASE_URL` (default `https://sentry.io`).

## Data flow
```
ErrorsTab (client) → GET /api/projects/[slug]/errors
  → requireAllowedUser → getProjectBySlug → sentryProjectRef
  → listUnresolvedIssues → sentryFetch → sentry.io REST
  → { issues, summary }
```
No polling (one fetch on tab open), matching CommitsTab.

## Error / empty states
Explicit and surfaced (never silent): `no_project`, `no_token`, `error` (with message), and empty (`No unresolved issues`). The token/mapping states tell the operator exactly how to fix it.

## Testing
The repo's tests are node + real Neon DB; `lib/github-api.ts` is unit-tested by mocking `globalThis.fetch` (`test/github-api.test.ts`). This slice has a real TDD path:

1. **`test/sentry-api.test.ts` (required, TDD):** stub `globalThis.fetch` (mirror the github-api test helpers) and assert `listUnresolvedIssues`:
   - builds the correct URL (org/project path + `query=is:unresolved&statsPeriod=24h&limit=25`),
   - sends the `Authorization: Bearer` header from `SENTRY_AUTH_TOKEN`,
   - maps raw issues → `SentryIssue` (incl. `count` string→number coercion),
   - throws `SentryApiError` (with status) on a non-2xx response.
2. **`mc project update --sentry-project` persistence (required):** a node+DB test (mirroring existing CLI/mutation tests) that `updateProject(id, { sentryProjectSlug })` persists and `getProjectBySlug` returns it; passing `null`/empty clears it.
3. **Route + `ErrorsTab`:** no component-test harness exists (per repo + the fleet-glance precedent), so verify via `npx tsc --noEmit`, `npm run lint`, `npx next build`, and an auth-gated browser dogfood (link a real project via `--sentry-project`, open the Errors tab, confirm issues render, and confirm the `no_project`/`no_token` states).

## Files touched
| File | Change |
|------|--------|
| `lib/db/schema.ts` | add `sentryProjectSlug` to `projects` |
| `migrations/NNNN_*.sql` | **new** — `ADD COLUMN sentry_project_slug` (drizzle-generated) |
| `lib/sentry.ts` | **new** — `sentryProjectRef` mapping helper |
| `lib/sentry-api.ts` | **new** — `sentryFetch`, `listUnresolvedIssues`, types, `SentryApiError` |
| `app/api/projects/[slug]/errors/route.ts` | **new** — the errors API route |
| `components/ErrorsTab.tsx` | **new** — client Errors tab |
| `app/p/[slug]/page.tsx` | add conditional `Errors` tab |
| `lib/mutations.ts` | `sentryProjectSlug` in `ProjectInput`/`ProjectUpdate`, create/update |
| `cli/index.ts` | `--sentry-project` flag + field map + spec registry |
| `cli/README.md`, `AGENTS.md` | document `--sentry-project` |
| `.env.example` | document `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_BASE_URL` |
| `test/sentry-api.test.ts` | **new** — fetch-mocked unit tests |
| `app/globals.css` | minimal `errors-*` classes only if needed |

## Out of scope
- Resolve/ignore write-actions (read-only v1).
- The Integrations-tab reshape (separate, later).
- Email/Zoho and Stripe slices (own specs).
- Multi-org Sentry (single `SENTRY_ORG` assumed).

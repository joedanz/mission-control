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

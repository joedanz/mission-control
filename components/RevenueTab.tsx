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
        <span className="revenue-count">
          {' · '}
          {summary.activeCount}
          {summary.truncated ? '+' : ''} active
        </span>
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

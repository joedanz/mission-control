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

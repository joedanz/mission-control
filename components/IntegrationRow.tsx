'use client';

// ABOUTME: One toolkit row in the Integrations tab — status pill + Connect/Check status/Disconnect.
// ABOUTME: Posts to /api/projects/[slug]/composio; opens the Composio hosted link on connect.

import { useState } from 'react';
import type { ToolkitView, ToolkitStatus } from '@/lib/composio-view';

function pillClass(status: ToolkitStatus): string {
  switch (status) {
    case 'active': return 'pill ok';
    case 'initializing': return 'pill warn';
    case 'error':
    case 'expired': return 'pill bad';
    default: return 'pill'; // not_connected | disconnected
  }
}

function pillLabel(status: ToolkitStatus): string {
  switch (status) {
    case 'active': return 'Active';
    case 'initializing': return 'Initializing';
    case 'error': return 'Error';
    case 'expired': return 'Expired';
    default: return 'Off'; // not_connected | disconnected
  }
}

type PostResult =
  | { ok: true; data: { linkUrl?: string; status?: string } }
  | { ok: false; error: string; message?: string };

export function IntegrationRow({
  slug,
  view,
  onChanged,
}: {
  slug: string;
  view: ToolkitView;
  onChanged: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  async function run(action: 'connect' | 'status' | 'disconnect') {
    setPending(true);
    setRowError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/composio`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, toolkit: view.slug }),
      });
      const json = (await res.json()) as PostResult;
      if (!json.ok) {
        setRowError(json.message ?? json.error ?? 'Request failed');
        return;
      }
      if (action === 'connect' && json.data.linkUrl) {
        window.open(json.data.linkUrl, '_blank', 'noopener,noreferrer');
      }
      await onChanged(); // refresh the list only after a successful mutation
    } catch (err) {
      setRowError(String(err));
    } finally {
      setPending(false);
    }
  }

  const connected = view.status === 'active';
  const initializing = view.status === 'initializing';

  return (
    <div className="intg-control">
      <span className="intg-control-label">
        {view.name}
        <span className="intg-tools"> · {view.toolCount} tools</span>
        {initializing && view.linkUrl && (
          <>
            {' · '}
            <a className="detail-link" href={view.linkUrl} target="_blank" rel="noreferrer">open link ↗</a>
          </>
        )}
        {rowError && <span className="intg-error"> · {rowError}</span>}
      </span>
      <span className="intg-actions">
        <span className={pillClass(view.status)}>{pillLabel(view.status)}</span>
        {connected ? (
          <button type="button" className="btn-sm btn-bad" disabled={pending} onClick={() => void run('disconnect')}>
            Disconnect
          </button>
        ) : initializing ? (
          <button type="button" className="btn-sm" disabled={pending} onClick={() => void run('status')}>
            Check status
          </button>
        ) : (
          <button type="button" className="btn-sm btn-ok" disabled={pending} onClick={() => void run('connect')}>
            Connect
          </button>
        )}
      </span>
    </div>
  );
}

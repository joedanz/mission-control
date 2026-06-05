'use client';

// ABOUTME: One connected MCP server row — composio (Disconnect / Check status, with an open-link anchor
// ABOUTME: while initializing) or remote (Remove). Posts the matching action to /api/projects/[slug]/composio.

import { useState } from 'react';
import type { McpServerView, McpServerStatus } from '@/lib/composio-view';

const PILL: Record<McpServerStatus, { cls: string; label: string }> = {
  active: { cls: 'pill ok', label: 'Active' },
  initializing: { cls: 'pill warn', label: 'Initializing' },
  error: { cls: 'pill bad', label: 'Error' },
  expired: { cls: 'pill bad', label: 'Expired' },
  disconnected: { cls: 'pill', label: 'Off' },
};

type PostResult = { ok: boolean; error?: string; message?: string };

export function McpServerRow({
  slug,
  view,
  onChanged,
}: {
  slug: string;
  view: McpServerView;
  onChanged: () => void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  async function run(body: Record<string, unknown>) {
    setPending(true);
    setRowError(null);
    try {
      const res = await fetch(`/api/projects/${slug}/composio`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as PostResult;
      if (!json.ok) {
        setRowError(json.message ?? json.error ?? 'Request failed');
        return;
      }
      await onChanged();
    } catch (err) {
      setRowError(String(err));
    } finally {
      setPending(false);
    }
  }

  const pill = PILL[view.status];
  const isRemote = view.source === 'remote';
  const initializing = view.status === 'initializing';

  return (
    <div className="intg-control">
      <span className="intg-control-label">
        <span className="mcp-source-tag">{isRemote ? 'Remote' : 'Composio'}</span>
        {view.name}
        {view.url && <span className="intg-tools"> · {view.url}</span>}
        {initializing && view.linkUrl && (
          <>
            {' · '}
            <a className="detail-link" href={view.linkUrl} target="_blank" rel="noreferrer">open link ↗</a>
          </>
        )}
        {rowError && <span className="intg-error"> · {rowError}</span>}
      </span>
      <span className="intg-actions">
        <span className={pill.cls}>{pill.label}</span>
        {isRemote ? (
          <button type="button" className="btn-sm btn-bad" disabled={pending} onClick={() => void run({ action: 'remove-remote', name: view.key })}>
            Remove
          </button>
        ) : initializing ? (
          <button type="button" className="btn-sm" disabled={pending} onClick={() => void run({ action: 'status', toolkit: view.key })}>
            Check status
          </button>
        ) : (
          <button type="button" className="btn-sm btn-bad" disabled={pending} onClick={() => void run({ action: 'disconnect', toolkit: view.key })}>
            Disconnect
          </button>
        )}
      </span>
    </div>
  );
}

'use client';

// ABOUTME: Add a remote MCP server from the MCP tab — name + URL + repeatable header rows. Header values
// ABOUTME: must be ${ENV} placeholders (server validates; secrets never reach the DB). Posts add-remote.

import { useState } from 'react';

type HeaderRow = { key: string; value: string };

export function McpRemoteForm({ slug, onAdded }: { slug: string; onAdded: () => void | Promise<void> }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<HeaderRow[]>([{ key: '', value: '' }]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setHeader(i: number, patch: Partial<HeaderRow>) {
    setHeaders((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function submit() {
    setPending(true);
    setError(null);
    try {
      const headerMap: Record<string, string> = {};
      for (const { key, value } of headers) if (key.trim()) headerMap[key.trim()] = value;
      const res = await fetch(`/api/projects/${slug}/composio`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'add-remote', name: name.trim(), url: url.trim(), headers: headerMap }),
      });
      const json = (await res.json()) as { ok: boolean; message?: string; error?: string };
      if (!json.ok) { setError(json.message ?? json.error ?? 'Add failed'); return; }
      setName(''); setUrl(''); setHeaders([{ key: '', value: '' }]);
      await onAdded();
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="mcp-remote-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <input className="mcp-input" placeholder="Name (e.g. docs)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Remote server name" />
      <input className="mcp-input" placeholder="https://server/mcp" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Remote server URL" />
      {headers.map((h, i) => (
        <div className="mcp-header-row" key={i}>
          <input className="mcp-input" placeholder="Header (e.g. Authorization)" value={h.key} onChange={(e) => setHeader(i, { key: e.target.value })} aria-label="Header name" />
          <input className="mcp-input" placeholder="Bearer ${ENV_VAR}" value={h.value} onChange={(e) => setHeader(i, { value: e.target.value })} aria-label="Header value" />
          {i === headers.length - 1 && (
            <button type="button" className="btn-sm" onClick={() => setHeaders((r) => [...r, { key: '', value: '' }])}>+ header</button>
          )}
        </div>
      ))}
      <p className="detail-muted mcp-hint">Header values must be <code>${'{ENV_VAR}'}</code> placeholders — resolved at spawn, never stored.</p>
      {error && <p className="intg-error">{error}</p>}
      <button type="submit" className="btn-sm btn-ok" disabled={pending || !name.trim() || !url.trim()}>Add remote server</button>
    </form>
  );
}

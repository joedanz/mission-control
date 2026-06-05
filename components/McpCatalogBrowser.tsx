'use client';

// ABOUTME: Browse Composio's live catalog inside the MCP tab — search box + results; Connect opens the
// ABOUTME: hosted OAuth link. Featured (curated) toolkits show by default; already-connected ones are tagged.

import { useState, useEffect, useRef } from 'react';

type CatalogItem = { slug: string; name: string; description: string; toolCount: number; featured: boolean; connected: boolean };
type CatalogResponse = { ok: boolean; error?: string; message?: string; data?: { toolkits: CatalogItem[] } };

export function McpCatalogBrowser({ slug, onConnected }: { slug: string; onConnected: () => void | Promise<void> }) {
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const loadSeq = useRef(0);

  useEffect(() => {
    const seq = ++loadSeq.current;
    const qs = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
    const t = setTimeout(() => {
      setLoading(true); // deferred into the timeout callback — keeps react-hooks/set-state-in-effect satisfied
      fetch(`/api/projects/${slug}/composio/catalog${qs}`)
        .then((res) => res.json())
        .then((json: CatalogResponse) => {
          if (seq !== loadSeq.current) return;
          if (json.ok && json.data) { setItems(json.data.toolkits); setError(null); }
          else setError(json.message ?? json.error ?? 'Failed to load catalog');
        })
        .catch((err: unknown) => { if (seq === loadSeq.current) setError(String(err)); })
        .finally(() => { if (seq === loadSeq.current) setLoading(false); });
    }, 250); // debounce typing
    return () => clearTimeout(t);
  }, [slug, search]);

  async function connect(toolkit: string) {
    setBusy(toolkit);
    try {
      const res = await fetch(`/api/projects/${slug}/composio`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'connect', toolkit }),
      });
      const json = (await res.json()) as { ok: boolean; data?: { linkUrl?: string }; message?: string; error?: string };
      if (json.ok && json.data?.linkUrl) window.open(json.data.linkUrl, '_blank', 'noopener,noreferrer');
      else if (!json.ok) setError(json.message ?? json.error ?? 'Connect failed');
      await onConnected();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mcp-catalog">
      <input
        className="mcp-search"
        type="search"
        placeholder="Search Composio catalog…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search Composio catalog"
      />
      {error && <p className="intg-error">{error}</p>}
      {loading && items.length === 0 ? (
        <p className="detail-muted">Loading…</p>
      ) : (
        <ul className="mcp-catalog-list">
          {items.map((t) => (
            <li key={t.slug} className="mcp-catalog-item">
              <span className="intg-control-label">
                {t.name}
                {t.featured && <span className="mcp-source-tag"> Featured</span>}
                <span className="intg-tools"> · {t.toolCount} tools</span>
              </span>
              {t.connected ? (
                <span className="pill ok">Connected</span>
              ) : (
                <button type="button" className="btn-sm btn-ok" disabled={busy === t.slug} onClick={() => void connect(t.slug)}>
                  Connect
                </button>
              )}
            </li>
          ))}
          {!loading && items.length === 0 && <li className="detail-muted">No toolkits found.</li>}
        </ul>
      )}
    </div>
  );
}

'use client';

// ABOUTME: MCP tab container — lists the project's attached MCP servers (composio + remote), a live
// ABOUTME: catalog browser to connect any toolkit, and a form to add a remote server. Re-polls
// ABOUTME: initializing connections on window focus (returning from OAuth).

import { useState, useEffect, useCallback, useRef } from 'react';
import type { McpServerView } from '@/lib/composio-view';
import { McpServerRow } from './McpServerRow';
import { McpCatalogBrowser } from './McpCatalogBrowser';
import { McpRemoteForm } from './McpRemoteForm';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; servers: McpServerView[] };

type GetResponse = { ok: boolean; error?: string; message?: string; data?: { servers: McpServerView[] } };

function toState(json: GetResponse): State {
  if (json.ok && json.data) return { kind: 'data', servers: json.data.servers };
  return { kind: 'error', message: json.message ?? json.error ?? 'Failed to load MCP servers' };
}

export function McpTab({ slug }: { slug: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const stateRef = useRef<State>(state);
  const loadSeq = useRef(0);

  useEffect(() => { stateRef.current = state; });

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await fetch(`/api/projects/${slug}/composio`);
      const json = (await res.json()) as GetResponse;
      if (seq === loadSeq.current) setState(toState(json));
    } catch (err) {
      if (seq === loadSeq.current) setState({ kind: 'error', message: String(err) });
    }
  }, [slug]);

  useEffect(() => {
    const seq = ++loadSeq.current;
    fetch(`/api/projects/${slug}/composio`)
      .then((res) => res.json())
      .then((json: GetResponse) => { if (seq === loadSeq.current) setState(toState(json)); })
      .catch((err: unknown) => { if (seq === loadSeq.current) setState({ kind: 'error', message: String(err) }); });
  }, [slug]);

  useEffect(() => {
    async function onFocus() {
      const s = stateRef.current;
      if (s.kind !== 'data') return;
      const initializing = s.servers.filter((t) => t.source === 'composio' && t.status === 'initializing');
      if (initializing.length === 0) return;
      await Promise.all(
        initializing.map((t) =>
          fetch(`/api/projects/${slug}/composio`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'status', toolkit: t.key }),
          }).catch(() => undefined),
        ),
      );
      await load();
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [slug, load]);

  return (
    <div className="detail-mcp">
      <section className="mcp-section">
        <h3 className="mcp-section-title">Connected</h3>
        {state.kind === 'loading' && (
          <div className="detail-integrations skeleton" aria-label="Loading MCP servers">
            <div className="skeleton-bar" /><div className="skeleton-bar" />
          </div>
        )}
        {state.kind === 'error' && (
          <div className="detail-integrations">
            <p className="detail-muted">Failed to load MCP servers: {state.message}</p>
            <button type="button" className="btn-sm" onClick={() => { setState({ kind: 'loading' }); void load(); }}>Retry</button>
          </div>
        )}
        {state.kind === 'data' && (
          <div className="detail-integrations">
            {state.servers.length === 0 && <p className="detail-muted">No MCP servers connected yet.</p>}
            {state.servers.map((t) => <McpServerRow key={`${t.source}:${t.key}`} slug={slug} view={t} onChanged={load} />)}
          </div>
        )}
      </section>

      <section className="mcp-section">
        <h3 className="mcp-section-title">Browse catalog</h3>
        <McpCatalogBrowser slug={slug} onConnected={load} />
      </section>

      <section className="mcp-section">
        <h3 className="mcp-section-title">Add remote server</h3>
        <McpRemoteForm slug={slug} onAdded={load} />
      </section>
    </div>
  );
}

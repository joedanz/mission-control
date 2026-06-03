'use client';

// ABOUTME: Integrations tab container — fetches the merged toolkit catalog for a project, renders a
// ABOUTME: row list, and re-polls any initializing connection when the window regains focus.

import { useState, useEffect, useCallback, useRef } from 'react';
import type { ToolkitView } from '@/lib/composio-view';
import { IntegrationRow } from './IntegrationRow';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; toolkits: ToolkitView[] };

type GetResponse = { ok: boolean; error?: string; message?: string; data?: { toolkits: ToolkitView[] } };

function toState(json: GetResponse): State {
  if (json.ok && json.data) return { kind: 'data', toolkits: json.data.toolkits };
  return { kind: 'error', message: json.message ?? json.error ?? 'Failed to load integrations' };
}

export function IntegrationsTab({ slug }: { slug: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const stateRef = useRef<State>(state);
  const loadSeq = useRef(0);

  // Mirror the latest state into a ref (in an effect, not during render) so the focus listener can
  // read the current toolkits without re-binding on every refresh.
  useEffect(() => {
    stateRef.current = state;
  });

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await fetch(`/api/projects/${slug}/composio`);
      const json = (await res.json()) as GetResponse;
      if (seq === loadSeq.current) setState(toState(json)); // ignore a superseded (out-of-order) load
    } catch (err) {
      if (seq === loadSeq.current) setState({ kind: 'error', message: String(err) });
    }
  }, [slug]);

  // Initial fetch on mount / slug change. Inlined with .then (rather than calling load()) so setState
  // is deferred into the promise callback — keeps react-hooks/set-state-in-effect satisfied.
  useEffect(() => {
    const seq = ++loadSeq.current;
    fetch(`/api/projects/${slug}/composio`)
      .then((res) => res.json())
      .then((json: GetResponse) => {
        if (seq === loadSeq.current) setState(toState(json));
      })
      .catch((err: unknown) => {
        if (seq === loadSeq.current) setState({ kind: 'error', message: String(err) });
      });
  }, [slug]);

  // On window focus, poll any still-initializing toolkit (the user just returned from authorizing), then refresh.
  useEffect(() => {
    async function onFocus() {
      const s = stateRef.current;
      if (s.kind !== 'data') return;
      const initializing = s.toolkits.filter((t) => t.status === 'initializing');
      if (initializing.length === 0) return;
      await Promise.all(
        initializing.map((t) =>
          fetch(`/api/projects/${slug}/composio`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'status', toolkit: t.slug }),
          }).catch(() => undefined),
        ),
      );
      await load();
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [slug, load]);

  if (state.kind === 'loading') {
    return (
      <div className="detail-integrations skeleton" aria-label="Loading integrations">
        <div className="skeleton-bar" />
        <div className="skeleton-bar" />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="detail-integrations">
        <p className="detail-muted">Failed to load integrations: {state.message}</p>
        <button
          type="button"
          className="btn-sm"
          onClick={() => {
            setState({ kind: 'loading' });
            void load();
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="detail-integrations">
      {state.toolkits.map((t) => (
        <IntegrationRow key={t.slug} slug={slug} view={t} onChanged={load} />
      ))}
    </div>
  );
}

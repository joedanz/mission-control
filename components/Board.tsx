'use client';

// ABOUTME: Client owner of the board's inline filter + category tabs.
// ABOUTME: Filters server-rendered rows by toggling `hidden`; re-applies via MutationObserver so a
// ABOUTME: revalidation re-render of the board can't silently drop the active filter.
// ABOUTME: The ⌘K jump palette now lives in the global top bar (components/chrome/CommandPalette).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchItem } from '@/lib/queries';

type TabKey = 'all' | 'client' | 'open_source' | 'internal';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'client', label: 'Client' },
  { key: 'open_source', label: 'OSS' },
  { key: 'internal', label: 'Internal' },
];

export function Board({ index, children }: { index: SearchItem[]; children: React.ReactNode }) {
  const boardRef = useRef<HTMLDivElement>(null);

  // Per-tab counts from the search index (category is the project type).
  const counts: Record<TabKey, number> = {
    all: index.length,
    client: index.filter((i) => i.category === 'client').length,
    open_source: index.filter((i) => i.category === 'open_source').length,
    internal: index.filter((i) => i.category === 'internal').length,
  };

  // ── tab + inline filter (combined) ──
  const [tab, setTab] = useState<TabKey>('all');
  const [query, setQuery] = useState('');
  const queryRef = useRef('');
  const tabRef = useRef<TabKey>('all');
  const tabBtnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [noMatches, setNoMatches] = useState(false);

  const applyFilter = useCallback((q: string, t: TabKey) => {
    const root = boardRef.current;
    if (!root) return;
    const needle = q.trim().toLowerCase();
    let anyVisible = false;
    root.querySelectorAll<HTMLElement>('.row').forEach((row) => {
      const text = row.getAttribute('data-search') ?? '';
      const cat = row.getAttribute('data-category') ?? '';
      const matchesText = needle === '' || text.includes(needle);
      const matchesTab = t === 'all' || cat === t;
      const visible = matchesText && matchesTab;
      row.hidden = !visible;
      if (visible) anyVisible = true;
    });
    setNoMatches(!anyVisible);
  }, []);

  useEffect(() => {
    queryRef.current = query;
    tabRef.current = tab;
    applyFilter(query, tab);
  }, [query, tab, applyFilter]);

  // Re-apply after the server board re-renders (e.g. after a task toggle's revalidation).
  useEffect(() => {
    const root = boardRef.current;
    if (!root) return;
    const obs = new MutationObserver(() => applyFilter(queryRef.current, tabRef.current));
    obs.observe(root, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [applyFilter]);

  function onTabKey(e: React.KeyboardEvent, i: number) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const next = (i + dir + TABS.length) % TABS.length;
      setTab(TABS[next].key);
      tabBtnRefs.current[next]?.focus();
    }
  }

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Project type">
        {TABS.map((t, i) => (
          <button
            key={t.key}
            ref={(el) => { tabBtnRefs.current[i] = el; }}
            type="button"
            role="tab"
            aria-selected={t.key === tab}
            tabIndex={t.key === tab ? 0 : -1}
            className={`tab${t.key === tab ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            {t.label}
            <span className="tab-count">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      <div className="searchbar">
        <input
          type="search"
          className="searchbar-input"
          placeholder="Filter projects…"
          aria-label="Filter projects"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="board" ref={boardRef}>
        {children}
        {noMatches && (
          <p className="board-empty">
            {query.trim() ? `No projects match “${query.trim()}”.` : 'No projects in this view.'}
          </p>
        )}
      </div>
    </>
  );
}

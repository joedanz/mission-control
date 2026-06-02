'use client';

// ABOUTME: Global ⌘K command palette — a top-bar trigger pill + the jump-to-project modal.
// ABOUTME: Lifted out of Board so it's available on every chrome route, not just the table.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SearchItem } from '@/lib/queries';

const CATEGORY_LABEL: Record<string, string> = {
  internal: 'Internal',
  open_source: 'Open Source',
  client: 'Client',
};

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" strokeLinecap="round" />
    </svg>
  );
}

export function CommandPalette({ index }: { index: SearchItem[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pq, setPq] = useState('');
  const [active, setActive] = useState(0);
  const paletteInputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const results = (() => {
    const n = pq.trim().toLowerCase();
    const list = n === ''
      ? index
      : index.filter((i) => `${i.name} ${i.slug} ${i.domain ?? ''}`.toLowerCase().includes(n));
    return list.slice(0, 8);
  })();

  const openPalette = useCallback(() => {
    openerRef.current = document.activeElement as HTMLElement;
    setPq('');
    setActive(0);
    setOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    openerRef.current?.focus?.();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); // Ctrl-K is the browser address-bar shortcut
        openPalette();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette]);

  useEffect(() => {
    if (open) paletteInputRef.current?.focus();
  }, [open]);

  // Clamp at render instead of in an effect (avoids set-state-in-effect).
  const activeIdx = results.length ? Math.min(active, results.length - 1) : 0;

  const go = useCallback((item: SearchItem | undefined) => {
    if (!item) return;
    closePalette();
    router.push(`/p/${item.slug}`);
  }, [closePalette, router]);

  function onPaletteKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[activeIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    } else if (e.key === 'Tab') {
      e.preventDefault(); // keep focus inside the palette
    }
  }

  return (
    <>
      <button type="button" className="chrome-search-trigger" onClick={openPalette} aria-label="Search projects">
        <SearchIcon />
        <span className="chrome-search-label">Search…</span>
        <kbd>⌘K</kbd>
      </button>

      {open && (
        <div className="modal-overlay" onClick={closePalette}>
          <div
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Jump to project"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              ref={paletteInputRef}
              type="text"
              className="palette-input"
              placeholder="Jump to a project…"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={results[activeIdx] ? `palette-opt-${results[activeIdx].slug}` : undefined}
              value={pq}
              onChange={(e) => {
                setPq(e.target.value);
                setActive(0);
              }}
              onKeyDown={onPaletteKey}
            />
            <ul className="palette-list" id="palette-list" role="listbox">
              {results.length === 0 && <li className="palette-none">No matches</li>}
              {results.map((item, i) => (
                <li
                  key={item.slug}
                  id={`palette-opt-${item.slug}`}
                  role="option"
                  aria-selected={i === activeIdx}
                  className={`palette-item${i === activeIdx ? ' active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    go(item);
                  }}
                >
                  <span className="palette-name">{item.name}</span>
                  <span className="palette-meta">{CATEGORY_LABEL[item.category] ?? item.category} · {item.status}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

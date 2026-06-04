'use client';

// ABOUTME: Accessible tab switcher for the project detail page. Server-rendered panel content is
// ABOUTME: passed in; active tab syncs to ?tab= for shareable deep links. Wrap in <Suspense>.

import { useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { resolveActiveTab } from '@/lib/tabs';

export type Tab = { key: string; label: string; content: React.ReactNode };

export function TabbedPanels({ tabs, aliases }: { tabs: Tab[]; aliases?: Record<string, string> }) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const fromUrl = sp.get('tab');
  const [activeKey, setActiveKey] = useState(() =>
    resolveActiveTab(fromUrl, tabs.map((t) => t.key), aliases),
  );
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function select(key: string, focus = false) {
    setActiveKey(key);
    const p = new URLSearchParams(Array.from(sp.entries()));
    p.set('tab', key);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
    if (focus) {
      const i = tabs.findIndex((t) => t.key === key);
      tabRefs.current[i]?.focus();
    }
  }

  function onKeyDown(e: React.KeyboardEvent, i: number) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      select(tabs[(i + dir + tabs.length) % tabs.length].key, true);
    }
  }

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Project sections">
        {tabs.map((t, i) => (
          <button
            key={t.key}
            ref={(el) => { tabRefs.current[i] = el; }}
            role="tab"
            id={`tab-${t.key}`}
            aria-controls={`panel-${t.key}`}
            aria-selected={t.key === activeKey}
            tabIndex={t.key === activeKey ? 0 : -1}
            className={`tab${t.key === activeKey ? ' active' : ''}`}
            onClick={() => select(t.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.key}
          role="tabpanel"
          id={`panel-${t.key}`}
          aria-labelledby={`tab-${t.key}`}
          className="panel"
          hidden={t.key !== activeKey}
        >
          {t.content}
        </div>
      ))}
    </>
  );
}

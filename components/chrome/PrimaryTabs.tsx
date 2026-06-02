'use client';

// ABOUTME: Root section tabs (Overview · Projects · Board · Mission · Profiles · Spend) for the chrome tab strip.
// ABOUTME: Active state derives from the pathname — layouts can't read it, so this is a client hook.

import { usePathname } from 'next/navigation';
import Link from 'next/link';

const TABS: { href: string; label: string }[] = [
  { href: '/', label: 'Overview' },
  { href: '/projects', label: 'Projects' },
  { href: '/board', label: 'Board' },
  { href: '/mission', label: 'Mission' },
  { href: '/profiles', label: 'Profiles' },
  { href: '/spend', label: 'Spend' },
];

export function PrimaryTabs() {
  const pathname = usePathname();
  return (
    <nav className="tabs" role="tablist" aria-label="Sections">
      {TABS.map((t) => {
        // exact match for "/" (everything startsWith "/"); prefix match for deeper sections
        const active = t.href === '/' ? pathname === '/' : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            role="tab"
            aria-selected={active}
            className={`tab${active ? ' active' : ''}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

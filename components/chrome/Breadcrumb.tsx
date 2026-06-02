'use client';

// ABOUTME: Top-bar breadcrumb. Shows "Projects / <name>" on a project detail route; nothing
// ABOUTME: elsewhere (the section tabs already indicate the root location). Name is resolved from
// ABOUTME: the search index so no extra fetch is needed.

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import type { SearchItem } from '@/lib/queries';

export function Breadcrumb({ index }: { index: SearchItem[] }) {
  const pathname = usePathname();
  if (!pathname.startsWith('/p/')) return null;

  const slug = decodeURIComponent(pathname.slice('/p/'.length).split('/')[0]);
  const name = index.find((i) => i.slug === slug)?.name ?? slug;

  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <Link href="/projects" className="breadcrumb-link">Projects</Link>
      <span className="breadcrumb-sep" aria-hidden="true">/</span>
      <span className="breadcrumb-current">{name}</span>
    </nav>
  );
}

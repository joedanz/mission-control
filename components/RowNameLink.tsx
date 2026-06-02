'use client';

// ABOUTME: Project name as a link to the detail page, living inside the row's <summary>.
// ABOUTME: preventDefault cancels the native <details> toggle (stopPropagation does NOT); then navigate.

import Link from 'next/link';
import { useRouter } from 'next/navigation';

export function RowNameLink({ slug, name }: { slug: string; name: string }) {
  const router = useRouter();
  return (
    <Link
      href={`/p/${slug}`}
      className="row-name"
      onClick={(e) => {
        e.preventDefault(); // stop the summary from toggling
        e.stopPropagation();
        router.push(`/p/${slug}`);
      }}
    >
      {name}
    </Link>
  );
}

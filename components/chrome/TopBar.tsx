// ABOUTME: Global top bar (Server Component) — brand, contextual breadcrumb, ⌘K search, account.
// ABOUTME: Pure layout shell; all interactivity lives in its client children. Rendered by the
// ABOUTME: sections layout and by the project detail page (which is outside that layout).

import Link from 'next/link';
import type { SearchItem } from '@/lib/queries';
import { Breadcrumb } from './Breadcrumb';
import { CommandPalette } from './CommandPalette';
import { AccountMenu } from './AccountMenu';
import { SysReadout } from './SysReadout';
import { ThemeToggle } from './ThemeToggle';

function BrandGlyph() {
  // Activity/heartbeat mark — reads as an instrument/monitoring console.
  return (
    <span className="glyph" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12h4l2-7 4 14 2-7h6" />
      </svg>
    </span>
  );
}

export function TopBar({ index, email }: { index: SearchItem[]; email: string }) {
  return (
    <header className="chrome-topbar">
      <div className="chrome-topbar-inner">
        <Link href="/" className="brand" aria-label="Mission Control home">
          <BrandGlyph />
          <span className="brand-word">Mission<span className="slash">{'//'}</span><span className="sub">Control</span></span>
        </Link>
        <Breadcrumb index={index} />
        <div className="chrome-topbar-right">
          <SysReadout />
          <CommandPalette index={index} />
          <ThemeToggle />
          <AccountMenu email={email} />
        </div>
      </div>
    </header>
  );
}

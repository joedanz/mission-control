'use client';

// ABOUTME: Top-bar account avatar + dropdown. Sign-out runs client-side via the BetterAuth client,
// ABOUTME: then navigates to /login and refreshes so server components re-evaluate auth.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from '@/lib/auth-client';

export function AccountMenu({ email }: { email: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const initial = (email.trim()[0] ?? '?').toUpperCase();

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  async function handleSignOut() {
    setBusy(true);
    try {
      await signOut();
    } finally {
      router.push('/login');
      router.refresh();
    }
  }

  return (
    <div className="account-menu" ref={ref}>
      <button
        type="button"
        className="account-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <span className="account-avatar" aria-hidden="true">{initial}</span>
      </button>
      {open && (
        <div className="account-dropdown" role="menu">
          <div className="account-email" title={email}>{email}</div>
          <button
            type="button"
            className="account-signout"
            role="menuitem"
            onClick={handleSignOut}
            disabled={busy}
          >
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}

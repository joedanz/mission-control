'use client';

// ABOUTME: Google sign-in screen. Only you@example.com is accepted (enforced server-side).

import { useState } from 'react';
import { signIn } from '@/lib/auth-client';

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGoogle() {
    setLoading(true);
    setError(null);
    try {
      await signIn.social({ provider: 'google', callbackURL: '/' });
    } catch {
      setError('Sign-in failed. This dashboard is restricted.');
      setLoading(false);
    }
  }

  return (
    <main className="login-wrap">
      <div className="login-card">
        <h1 className="login-mark">
          MC
        </h1>
        <p className="login-sub">Mission Control</p>
        <button className="login-btn" onClick={handleGoogle} disabled={loading}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 11v3.2h4.5c-.2 1.2-1.4 3.5-4.5 3.5-2.7 0-4.9-2.2-4.9-5s2.2-5 4.9-5c1.5 0 2.6.7 3.2 1.2l2.2-2.1C16.7 4.5 14.6 3.6 12 3.6 7.3 3.6 3.5 7.4 3.5 12s3.8 8.4 8.5 8.4c4.9 0 8.1-3.4 8.1-8.3 0-.6 0-1-.1-1.4H12z"
            />
          </svg>
          {loading ? 'Redirecting…' : 'Sign in with Google'}
        </button>
        {error && <p className="login-error">{error}</p>}
        <p className="login-note">Restricted to you@example.com</p>
      </div>
    </main>
  );
}

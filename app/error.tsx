'use client';

// ABOUTME: App-wide error boundary — catches render/data failures in the route segments (e.g. a Neon
// ABOUTME: cold-start timeout in a server page, which otherwise drops the operator to the bare 500 page)
// ABOUTME: and offers recovery (retry / home). Renders inside the root layout, so it keeps fonts + theme.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  useEffect(() => {
    console.error('[app error boundary]', error);
  }, [error]);

  // reset() alone re-renders the SAME failed server payload (no re-fetch), so a transient Neon error
  // would just re-throw. router.refresh() re-fetches the server components first, then reset() clears
  // the boundary — the stable equivalent of Next's unstable_retry, which is what "try again" needs.
  function retry() {
    router.refresh();
    reset();
  }

  return (
    <main className="fault-wrap">
      <div className="fault-card">
        <h1 className="fault-mark">
          MC
        </h1>
        <p className="fault-code">error · something broke</p>
        <p className="fault-msg">
          The console hit an unexpected error loading this view. This is usually transient — try again.
          {error.digest ? <span className="fault-ref"> (ref {error.digest})</span> : null}
        </p>
        <div className="fault-actions">
          <button className="btn btn-accent" onClick={retry}>
            Try again
          </button>
          {/* A hard navigation (not next/link) is deliberate here: it re-initializes the app from a
              clean slate, which is the safer recovery when a segment has already errored. */}
          <button className="btn" onClick={() => window.location.assign('/')}>
            Back to console
          </button>
        </div>
      </div>
    </main>
  );
}

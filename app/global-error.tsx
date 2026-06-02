'use client';

// ABOUTME: Last-resort boundary for failures in the ROOT layout itself, where app/error.tsx can't reach.
// ABOUTME: It REPLACES the root layout, so it must render its own <html>/<body>, and uses inline styles
// ABOUTME: (globals.css / the theme may not have loaded if the layout is what failed).

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          minHeight: '100vh',
          margin: 0,
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          background: '#0b0b0d',
          color: '#e7e7ea',
        }}
      >
        <div style={{ textAlign: 'center', padding: 24, maxWidth: 420 }}>
          <h1 style={{ fontFamily: 'ui-monospace, monospace', fontSize: 22, fontWeight: 600 }}>
            MC
          </h1>
          <p style={{ opacity: 0.7, lineHeight: 1.5, fontSize: 14 }}>
            The console failed to load. This is usually transient.
            {error.digest ? ` (ref ${error.digest})` : ''}
          </p>
          {/* A root-layout failure means we're outside the router tree, so router.refresh() isn't
              available — a full reload is the only reliable retry. */}
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 16,
              padding: '10px 18px',
              cursor: 'pointer',
              background: 'transparent',
              color: 'inherit',
              border: '1px solid #444',
              borderRadius: 8,
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}

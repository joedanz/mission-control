// ABOUTME: 404 screen for notFound() (e.g. an unknown / archived project slug) — replaces Next's bare
// ABOUTME: default page with on-theme chrome and a link back to the console.

import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="fault-wrap">
      <div className="fault-card">
        <h1 className="fault-mark">
          MC
        </h1>
        <p className="fault-code">404 · not found</p>
        <p className="fault-msg">
          That page or project doesn’t exist. It may have been renamed, archived, or never existed.
        </p>
        <div className="fault-actions">
          <Link className="btn btn-accent" href="/">
            Back to console
          </Link>
        </div>
      </div>
    </main>
  );
}

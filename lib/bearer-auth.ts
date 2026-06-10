// ABOUTME: Constant-time Bearer-token comparison for the ingest + cron-reap routes. Plain `!==` short-circuits
// ABOUTME: on the first differing byte (a timing oracle); timingSafeEqual does not. Token length is leaked (the
// ABOUTME: lengths must match to compare), which is acceptable for a fixed-length shared secret. No DB, no throw.

import { timingSafeEqual } from 'node:crypto';

/** True iff `header` equals `Bearer <token>` in constant time. False on a missing header or empty token. */
export function bearerMatches(header: string | null, token: string | undefined | null): boolean {
  if (!token || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${token}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ABOUTME: Pure HMAC-SHA256 webhook signature verification (slice 8) — the one new primitive for the
// ABOUTME: event/webhook trigger. GitHub `X-Hub-Signature-256: sha256=<hex>` compatible; constant-time via
// ABOUTME: timingSafeEqual; never throws (a bad/missing header or wrong secret returns false → caller 401s).
// ABOUTME: No DB, no spawn, no React (mirrors lib/workflows.ts) — verified against the documented GitHub contract.

import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';

/** Verify a GitHub-style `sha256=<hex>` HMAC over the RAW request body (the exact bytes, not a re-serialized
 *  parse). Computes HMAC-SHA256(secret, rawBody) and compares it constant-time with the header digest. Returns
 *  false — never throws — on a missing/malformed header, a non-`sha256=` scheme, a length mismatch, or a wrong
 *  secret, so the route can reject before any DB effect. An empty secret also fails (an unconfigured endpoint
 *  must not accept). */
export function verifyWebhookSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!secret || !header || !header.startsWith(PREFIX)) return false;
  const provided = header.slice(PREFIX.length);
  // Require all-hex BEFORE decoding: Buffer.from(x,'hex') silently stops at the first non-hex char, so a
  // same-string-length but non-hex digest would decode SHORTER than `expected` and make timingSafeEqual throw
  // (it demands equal BYTE lengths). The hex guard + the equal-string-length guard below together guarantee
  // both buffers are exactly 32 bytes, so the compare returns false instead of throwing.
  if (!/^[0-9a-f]+$/i.test(provided)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}

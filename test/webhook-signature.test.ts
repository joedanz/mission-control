// ABOUTME: Pure unit tests for verifyWebhookSignature (slice 8) — the HMAC-SHA256 webhook gate. No DB, no
// ABOUTME: network: sign a body with a known secret and assert valid passes while wrong-secret / tampered-body /
// ABOUTME: malformed-header all fail. Cross-checks the exact GitHub `sha256=<hex>` digest so the contract is pinned.

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from '../lib/webhook-signature';

const SECRET = 'top-secret-key';
const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('verifyWebhookSignature', () => {
  const body = JSON.stringify({ action: 'opened', issue: { number: 7 } });

  it('accepts a valid GitHub-style sha256 signature over the raw body', () => {
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(verifyWebhookSignature(body, sign(body, 'other-secret'), SECRET)).toBe(false);
  });

  it('rejects when the body was tampered with after signing', () => {
    const header = sign(body);
    expect(verifyWebhookSignature(body + ' ', header, SECRET)).toBe(false);
  });

  it('rejects a missing, empty, or wrong-scheme header', () => {
    const valid = sign(body).slice('sha256='.length);
    expect(verifyWebhookSignature(body, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, '', SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, `sha1=${valid}`, SECRET)).toBe(false); // wrong scheme
    expect(verifyWebhookSignature(body, valid, SECRET)).toBe(false); // bare hex, no prefix
  });

  it('rejects a malformed (non-hex / wrong-length) digest without throwing', () => {
    expect(verifyWebhookSignature(body, 'sha256=not-hex-zz', SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, 'sha256=abcd', SECRET)).toBe(false); // too short to be a sha256
    // A 64-char NON-hex digest is the same string length as a real sha256 hex but decodes to a shorter buffer;
    // without the all-hex guard this would make timingSafeEqual throw (unequal byte lengths) → must return false.
    expect(verifyWebhookSignature(body, `sha256=${'z'.repeat(64)}`, SECRET)).toBe(false);
  });

  it('rejects when the configured secret is empty (an unconfigured endpoint must not accept)', () => {
    expect(verifyWebhookSignature(body, sign(body, ''), '')).toBe(false);
  });
});

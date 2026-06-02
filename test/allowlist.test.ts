// ABOUTME: Unit tests for the sign-in allowlist (lib/allowlist.ts) — the real authz boundary behind every
// ABOUTME: page + server action. Pins the FAIL-CLOSED property: an empty/unset ALLOWED_EMAIL rejects everyone.
//
// ALLOWED_EMAIL is read at MODULE LOAD (a top-level const), so each env permutation needs a FRESH import
// (vi.resetModules + dynamic import) — calling the function with a different argument can't change it.
// Pure + DB-free, so this file is fast and needs no Neon.

import { describe, it, expect, afterEach, vi } from 'vitest';

const ORIGINAL = process.env.ALLOWED_EMAIL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ALLOWED_EMAIL;
  else process.env.ALLOWED_EMAIL = ORIGINAL;
  vi.resetModules();
});

/** Reload the allowlist with ALLOWED_EMAIL set to `value` (null = unset), picking up the new env at import. */
async function loadAllowlist(value: string | null) {
  if (value === null) delete process.env.ALLOWED_EMAIL;
  else process.env.ALLOWED_EMAIL = value;
  vi.resetModules();
  return import('../lib/allowlist');
}

describe('isAllowed — fail-closed', () => {
  it('rejects everyone when ALLOWED_EMAIL is unset — including a would-be match', async () => {
    const { isAllowed } = await loadAllowlist(null);
    expect(isAllowed('you@example.com')).toBe(false); // the load-bearing assertion: no allowlist ⇒ nobody in
    expect(isAllowed('')).toBe(false);
    expect(isAllowed(null)).toBe(false);
    expect(isAllowed(undefined)).toBe(false);
  });

  it('rejects everyone when ALLOWED_EMAIL is empty / whitespace-only', async () => {
    const { isAllowed } = await loadAllowlist('   ');
    expect(isAllowed('you@example.com')).toBe(false); // trims to '' ⇒ still fail-closed
  });
});

describe('isAllowed — matching', () => {
  it('admits the configured address, case- and whitespace-insensitively', async () => {
    const { isAllowed } = await loadAllowlist('You@Example.com');
    expect(isAllowed('you@example.com')).toBe(true);
    expect(isAllowed('  YOU@EXAMPLE.com  ')).toBe(true);
  });

  it('rejects any other address and any null/undefined/empty input', async () => {
    const { isAllowed } = await loadAllowlist('you@example.com');
    expect(isAllowed('eve@evil.com')).toBe(false);
    expect(isAllowed('you@example.com.evil.com')).toBe(false); // no prefix/substring match
    expect(isAllowed(null)).toBe(false);
    expect(isAllowed(undefined)).toBe(false);
    expect(isAllowed('')).toBe(false);
  });
});

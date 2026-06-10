// ABOUTME: Unit tests for the constant-time Bearer comparison (audit LT5). Pure — no DB, no network. Asserts
// ABOUTME: the match/▸mismatch semantics; the timing-safety itself isn't observable in a unit test, but the
// ABOUTME: behavioural contract (equal-length-required, missing-header/empty-token fail) is.

import { describe, it, expect } from 'vitest';
import { bearerMatches } from '../lib/bearer-auth';

describe('bearerMatches (audit LT5)', () => {
  it('matches the exact Bearer <token>', () => {
    expect(bearerMatches('Bearer s3cret', 's3cret')).toBe(true);
  });
  it('rejects a wrong token, a wrong scheme, and a length mismatch', () => {
    expect(bearerMatches('Bearer s3cret', 'other')).toBe(false);
    expect(bearerMatches('Token s3cret', 's3cret')).toBe(false);
    expect(bearerMatches('Bearer s3cre', 's3cret')).toBe(false);
    expect(bearerMatches('Bearer s3crett', 's3cret')).toBe(false);
  });
  it('fails closed on a missing header or empty/undefined token', () => {
    expect(bearerMatches(null, 's3cret')).toBe(false);
    expect(bearerMatches('Bearer ', '')).toBe(false);
    expect(bearerMatches('Bearer x', undefined)).toBe(false);
  });
});

// ABOUTME: Unit test for requireAllowedUser() — the real per-request auth boundary (middleware is only a
// ABOUTME: UX redirect). Mocks BetterAuth's session + the allowlist so we exercise the GATE's own logic in
// ABOUTME: isolation: fail-closed on a null session and on a disallowed email, pass on an allowed one, and
// ABOUTME: ALWAYS read with disableCookieCache:true (so a revoked session can't ride the 5-min cookie cache).

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted so these spies exist before the (hoisted) vi.mock factories close over them.
const { getSession, isAllowed } = vi.hoisted(() => ({ getSession: vi.fn(), isAllowed: vi.fn() }));

vi.mock('server-only', () => ({})); // no-op: the package throws if imported in a non-RSC bundle
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('../lib/auth', () => ({ auth: { api: { getSession } } }));
vi.mock('../lib/allowlist', () => ({ isAllowed }));

import { requireAllowedUser, UnauthorizedError } from '../lib/authz';

describe('requireAllowedUser — fail-closed session gate', () => {
  beforeEach(() => {
    getSession.mockReset();
    isAllowed.mockReset();
  });

  it('throws UnauthorizedError when there is no session', async () => {
    getSession.mockResolvedValue(null);
    await expect(requireAllowedUser()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(isAllowed).not.toHaveBeenCalled(); // short-circuits before the allowlist check
  });

  it('throws when the session email is not allowed (valid session, wrong user)', async () => {
    getSession.mockResolvedValue({ user: { email: 'intruder@example.com' } });
    isAllowed.mockReturnValue(false);
    await expect(requireAllowedUser()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(isAllowed).toHaveBeenCalledWith('intruder@example.com');
  });

  it('returns the session when the email is allowed', async () => {
    const session = { user: { email: 'allowed@example.com' } };
    getSession.mockResolvedValue(session);
    isAllowed.mockReturnValue(true);
    await expect(requireAllowedUser()).resolves.toBe(session);
  });

  it('always reads with disableCookieCache:true so a revoked session cannot ride the cache', async () => {
    getSession.mockResolvedValue({ user: { email: 'allowed@example.com' } });
    isAllowed.mockReturnValue(true);
    await requireAllowedUser();
    expect(getSession).toHaveBeenCalledWith(
      expect.objectContaining({ query: { disableCookieCache: true } }),
    );
  });
});

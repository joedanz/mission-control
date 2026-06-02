// ABOUTME: Per-request authorization — the REAL boundary (middleware is only a UX redirect).
// ABOUTME: Call requireAllowedUser() at the top of every server action and protected page.

import 'server-only';
import { headers } from 'next/headers';
import { auth } from './auth';
import { isAllowed } from './allowlist';

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Returns the session if (and only if) a valid session belongs to the allowed
 * email. Throws otherwise. Fail-closed: null session, wrong email, or empty
 * ALLOWED_EMAIL all reject. disableCookieCache forces a fresh DB check so a
 * revoked session can't keep authorizing through the 5-minute cookie cache.
 */
export async function requireAllowedUser() {
  const session = await auth.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  });

  if (!session?.user?.email || !isAllowed(session.user.email)) {
    throw new UnauthorizedError();
  }

  return session;
}

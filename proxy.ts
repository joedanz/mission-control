// ABOUTME: UX-only auth gate — optimistic cookie-presence check that redirects to /login.
// ABOUTME: NOT a security boundary. Real enforcement is requireAllowedUser() in pages/actions.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except: /login, the auth API, the bearer-auth ingest + cron routes, the public
  // HMAC-authed workflow webhook (all authenticate via token/signature, not a session cookie),
  // Next internals, and static assets.
  matcher: [
    '/((?!login|api/auth|api/ingest|api/cron|api/workflows/[^/]+/webhook|_next/static|_next/image|favicon.ico).*)',
  ],
};

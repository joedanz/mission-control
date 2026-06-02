// ABOUTME: BetterAuth config — Google OAuth only, locked to a single allowed email.
// ABOUTME: The allowlist is enforced at user-creation here AND per-request in lib/authz.ts.

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { db } from './db/index';
import * as schema from './db/schema';
import { ALLOWED_EMAIL, isAllowed } from './allowlist';

if (!process.env.BETTER_AUTH_SECRET) {
  throw new Error('BETTER_AUTH_SECRET environment variable is not set');
}
if (!process.env.BETTER_AUTH_URL) {
  throw new Error('BETTER_AUTH_URL environment variable is not set');
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verificationTokens,
    },
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,

  // Google OAuth only.
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      enabled: !!process.env.GOOGLE_CLIENT_ID,
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 24 hours
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },

  advanced: {
    useSecureCookies: process.env.NODE_ENV === 'production',
    defaultCookieAttributes: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/',
    },
  },

  // Hard lock: reject creation of any user that is not the allowed, verified email.
  // Fail-closed — isAllowed() returns false when ALLOWED_EMAIL is empty.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const email = (user.email ?? '').toLowerCase().trim();
          if (!isAllowed(email) || user.emailVerified !== true) {
            throw new APIError('FORBIDDEN', {
              message: `Sign-in restricted to ${ALLOWED_EMAIL || '(no allowed email configured)'}.`,
            });
          }
          return { data: user };
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;

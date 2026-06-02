// ABOUTME: BetterAuth catch-all route handler (Node runtime — never edge; it touches lib/db).
// ABOUTME: Rate limiting is handled by BetterAuth's built-in limiter (enabled by default).

import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';

export const runtime = 'nodejs';

export const { GET, POST } = toNextJsHandler(auth);

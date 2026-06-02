// ABOUTME: Drizzle Kit config for migrations against Neon (run with the OWNER DATABASE_URL).

import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Load .env.local (Next.js convention) first, then .env as fallback.
config({ path: '.env.local' });
config();

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || '',
  },
  verbose: true,
  strict: true,
});

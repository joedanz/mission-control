// ABOUTME: Vitest config for the claim-lifecycle suite. Tests run against the real Neon instance
// ABOUTME: (DATABASE_URL from .env.local) so single-statement neon-http semantics are exercised, not mocked.

import { defineConfig } from 'vitest/config';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';

// Load .env.local into process.env (main) AND pass to test workers via test.env so lib/db sees DATABASE_URL.
const parsed = loadEnv({ path: '.env.local' }).parsed ?? {};

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    environment: 'node',
    env: parsed,
    include: ['test/**/*.test.ts'],
    fileParallelism: false, // tests share one DB; isolate by throwaway project, run serially
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});

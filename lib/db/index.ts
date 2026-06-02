// ABOUTME: Drizzle ORM client for Neon PostgreSQL via the serverless HTTP driver.
// ABOUTME: Shared by the Next.js app, the seed script, and the CLI. No `server-only`, no dotenv side-effects.

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const sql = neon(connectionString);

export const db = drizzle(sql, { schema });

export * from './schema';

// ABOUTME: Credential resolution for the mc CLI. Runs before lib/db is imported.
// ABOUTME: Prefers the scoped AGENT_DATABASE_URL; refuses the owner-role fallback unless opted in.

import { config as loadDotenv } from 'dotenv';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Where the local credential file lives. Honors $MC_ENV_FILE then $XDG_CONFIG_HOME. */
export function credentialPath(): string {
  if (process.env.MC_ENV_FILE) return process.env.MC_ENV_FILE;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'mc', 'env');
}

let resolved = false;

/** Resolve DB credentials into process.env.DATABASE_URL BEFORE importing lib/db.
 *  Throws ConfigError (CLI maps to exit 4) on any misconfiguration. Idempotent. */
export function ensureDbCredentials(): void {
  if (resolved) return;

  // 1. Load the local credential file unless AGENT_DATABASE_URL is ALREADY in the environment (the recommended
  //    remote/CI path). Crucially we do NOT also short-circuit on a pre-set DATABASE_URL: direnv / a CI
  //    migration job / a shell that exported it for the web app would otherwise skip the file that holds the
  //    scoped AGENT_DATABASE_URL — then step 3 throws telling the user to populate the very file it refused to
  //    read. dotenv does not override existing vars, so loading the file leaves a pre-set DATABASE_URL intact.
  if (!process.env.AGENT_DATABASE_URL) {
    // 2. Load the local credential file — but only if its perms are tight.
    const path = credentialPath();
    let exists = true;
    try {
      const looseBits = statSync(path).mode & 0o077; // group/other bits
      if (looseBits !== 0) {
        throw new ConfigError(
          `Credential file is group/world-readable. Run: chmod 600 ${path}`,
        );
      }
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      exists = false; // ENOENT — fall through to the unset check below
    }
    if (exists) loadDotenv({ path });
  }

  // 3. Prefer the scoped agent role. No SILENT owner-role fallback.
  if (process.env.AGENT_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.AGENT_DATABASE_URL;
  } else if (process.env.DATABASE_URL) {
    if (process.env.MC_ALLOW_DATABASE_URL_FALLBACK === '1') {
      process.stderr.write(
        '[mc] AGENT_DATABASE_URL not set — using DATABASE_URL (MC_ALLOW_DATABASE_URL_FALLBACK=1).\n',
      );
    } else {
      throw new ConfigError(
        `AGENT_DATABASE_URL is not set. Set it in the environment or in ${credentialPath()} (chmod 600). ` +
          `To deliberately use DATABASE_URL instead, set MC_ALLOW_DATABASE_URL_FALLBACK=1 (NOT recommended — it may be the owner role).`,
      );
    }
  } else {
    throw new ConfigError(
      `No database credential found. Set AGENT_DATABASE_URL in the environment, or create ${credentialPath()} (chmod 600) containing AGENT_DATABASE_URL=...`,
    );
  }

  resolved = true;
}

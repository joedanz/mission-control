// ABOUTME: Pure helpers for 'remote'-source MCP connections — build the mcpServers entry + validate
// ABOUTME: operator input (URL + ${ENV}-placeholder headers). No DB, no network.

import type { McpServerConfig } from './db/schema';
import { ValidationError } from './validation';

// A header value must reference at least one ${ENV_VAR} placeholder so a raw secret can't be persisted;
// the daemon substring-substitutes these at spawn (Bearer ${TOKEN} is valid).
const PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

/** One already-loaded remote-source row: the inputs to emit a single mcpServers entry. */
export type RemoteMcpRow = { remoteName: string; remoteUrl: string; remoteHeaders: Record<string, string> | null };

/** Build the mcpServers map from remote-source rows. Each row → one http entry keyed by its remoteName,
 *  carrying the stored ${ENV}-placeholder headers (the daemon resolves them at spawn, never here). The
 *  headers key is omitted when the row has none. */
export function buildRemoteMcpServers(rows: RemoteMcpRow[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const { remoteName, remoteUrl, remoteHeaders } of rows) {
    out[remoteName] = {
      type: 'http',
      url: remoteUrl,
      ...(remoteHeaders && Object.keys(remoteHeaders).length ? { headers: remoteHeaders } : {}),
    };
  }
  return out;
}

/** Validate + normalize operator input for `mc mcp add-remote`. Trims the name; requires an http(s) URL;
 *  requires every header value to reference an ${ENV_VAR} placeholder. Throws ValidationError otherwise. */
export function validateRemoteInput(input: { name: string; url: string; headers: Record<string, string> }): {
  name: string;
  url: string;
  headers: Record<string, string>;
} {
  const name = input.name.trim();
  if (!name) throw new ValidationError('name', 'a remote server needs a non-empty --name');
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new ValidationError('url', `not a valid URL: ${input.url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('url', `--url must be http(s): ${input.url}`);
  }
  for (const [k, v] of Object.entries(input.headers)) {
    if (!PLACEHOLDER.test(v)) {
      throw new ValidationError('header', `header "${k}" must reference an \${ENV_VAR} placeholder, not a literal secret`);
    }
  }
  return { name, url: input.url, headers: input.headers };
}

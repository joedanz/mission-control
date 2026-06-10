// ABOUTME: Pure helpers for 'remote'-source MCP connections — build the mcpServers entry + validate
// ABOUTME: operator input (URL + ${ENV}-placeholder headers). No DB, no network.

import type { McpServerConfig } from './db/schema';
import { ValidationError } from './validation';

// A header value must reference at least one ${ENV_VAR} placeholder so a raw secret can't be persisted;
// the daemon substring-substitutes these at spawn (Bearer ${TOKEN} is valid).
const PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;
// Query-param keys that look like a credential — a literal value here is a secret leaking into the stored URL.
const CRED_QUERY_KEY = /^(api[-_]?key|access[-_]?token|token|secret|password|auth|key|sig|signature)$/i;

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
  // The URL must not embed a LITERAL credential. Many remote MCP endpoints authenticate via a query token
  // (?api_key=…), which would be persisted verbatim in mcp_connections.remoteUrl and echoed to the browser /
  // `mc mcp list` — breaking the "secrets are only ${ENV} placeholders" invariant the headers already enforce.
  // A ${ENV_VAR} placeholder is allowed: the daemon resolves it at spawn (resolveMcpConfigJson now covers url). (M20)
  for (const [k, v] of parsed.searchParams) {
    if (CRED_QUERY_KEY.test(k) && v && !PLACEHOLDER.test(v)) {
      throw new ValidationError('url', `URL query param "${k}" looks like a literal secret — use an \${ENV_VAR} placeholder (e.g. ?${k}=\${MY_TOKEN}), resolved at spawn, not a literal value`);
    }
  }
  for (const [k, v] of Object.entries(input.headers)) {
    if (!PLACEHOLDER.test(v)) {
      throw new ValidationError('header', `header "${k}" must reference an \${ENV_VAR} placeholder, not a literal secret`);
    }
  }
  return { name, url: input.url, headers: input.headers };
}

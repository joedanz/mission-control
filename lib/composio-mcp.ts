// ABOUTME: Pure builder that turns a project's active Composio connections into an mcpServers map for
// ABOUTME: a spawned agent. No DB, no network — the DB join lives in composio-connections.ts.

import type { McpServerConfig } from './db/schema';

/** Stable mcpServers key for a toolkit (matches the slice-1 proof's "composio-linear"). */
export function composioServerKey(toolkitSlug: string): string {
  return `composio-${toolkitSlug}`;
}

/** Build the mcpServers map from already-joined active-connection rows. Each row → one http server
 *  entry carrying the ${COMPOSIO_API_KEY} placeholder (the daemon resolves it at spawn, never here).
 *  The caller passes ONLY the rows it wants emitted (active, with a known mcpUrl). */
export function buildConnectionMcpServers(
  rows: { toolkitSlug: string; userId: string; mcpUrl: string }[],
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const { toolkitSlug, userId, mcpUrl } of rows) {
    out[composioServerKey(toolkitSlug)] = {
      type: 'http',
      url: `${mcpUrl}?user_id=${encodeURIComponent(userId)}`,
      headers: { 'x-api-key': '${COMPOSIO_API_KEY}' },
    };
  }
  return out;
}

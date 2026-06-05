// ABOUTME: Pure mapping of a project's mcp_connections rows (both sources) to display views for the
// ABOUTME: MCP tab's Connected section. One view per actual row — no catalog placeholders. No DB/network.

import type { McpConnection, ConnectionStatus } from './db/schema';
import { getCatalogEntry } from './composio-catalog';

export type McpServerStatus = ConnectionStatus; // every row has a real status (remote rows are pinned 'active')

export type McpServerView = {
  source: 'composio' | 'remote';
  key: string;        // toolkitSlug (composio) or remoteName (remote) — stable React key + POST identifier
  name: string;       // composio: catalog name or slug; remote: remoteName
  toolkitSlug: string | null;
  url: string | null;        // remote only
  status: McpServerStatus;
  linkUrl: string | null;    // composio, only while initializing
  error: string | null;
};

/** Map every connection row to a view. Composio rows resolve a display name from the static catalog,
 *  falling back to the raw slug (a toolkit connected via the CLI need not be curated). Remote rows
 *  carry their URL. No synthesized "not_connected" entries — discovery lives in the catalog browser. */
export function mcpServerViews(connections: McpConnection[]): McpServerView[] {
  return connections.map((c) => {
    if (c.source === 'remote') {
      return {
        source: 'remote', key: c.remoteName ?? c.id, name: c.remoteName ?? c.id,
        toolkitSlug: null, url: c.remoteUrl, status: c.status, linkUrl: null, error: c.error,
      };
    }
    const slug = c.toolkitSlug ?? c.id;
    return {
      source: 'composio', key: slug, name: getCatalogEntry(slug)?.name ?? slug,
      toolkitSlug: c.toolkitSlug, url: null, status: c.status,
      linkUrl: c.status === 'initializing' ? c.linkUrl : null, error: c.error,
    };
  });
}

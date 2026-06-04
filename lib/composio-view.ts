// ABOUTME: Pure overlay of a project's Composio connection rows onto the static catalog. Every catalog
// ABOUTME: toolkit yields a ToolkitView; toolkits with no row are 'not_connected'. No DB, no network.

import type { McpConnection, ConnectionStatus } from './db/schema';
import { COMPOSIO_CATALOG, catalogSlugs } from './composio-catalog';

// A toolkit row's status is its connection status, plus 'not_connected' for toolkits with no row.
export type ToolkitStatus = ConnectionStatus | 'not_connected';

export type ToolkitView = {
  slug: string;
  name: string;
  toolCount: number;
  status: ToolkitStatus;
  linkUrl: string | null; // only meaningful while initializing
  error: string | null;
};

/** Overlay a project's connection rows onto the full static catalog. */
export function toolkitViews(connections: McpConnection[]): ToolkitView[] {
  const bySlug = new Map(connections.map((c) => [c.toolkitSlug, c]));
  return catalogSlugs().map((slug) => {
    const entry = COMPOSIO_CATALOG[slug];
    const conn = bySlug.get(slug);
    return {
      slug,
      name: entry.name,
      toolCount: entry.allowedTools.length,
      status: conn?.status ?? 'not_connected',
      linkUrl: conn?.status === 'initializing' ? conn.linkUrl : null,
      error: conn?.error ?? null,
    };
  });
}

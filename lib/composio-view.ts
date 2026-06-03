// ABOUTME: Pure overlay of a project's Composio connection rows onto the static catalog. Every catalog
// ABOUTME: toolkit yields a ToolkitView; toolkits with no row are 'not_connected'. No DB, no network.

import type { ComposioConnection } from './db/schema';
import { COMPOSIO_CATALOG, catalogSlugs } from './composio-catalog';

export type ToolkitStatus =
  | 'active' | 'initializing' | 'error' | 'expired' | 'disconnected' | 'not_connected';

export type ToolkitView = {
  slug: string;
  name: string;
  toolCount: number;
  status: ToolkitStatus;
  linkUrl: string | null; // only meaningful while initializing
  error: string | null;
};

/** Overlay a project's connection rows onto the full static catalog. */
export function toolkitViews(connections: ComposioConnection[]): ToolkitView[] {
  const bySlug = new Map(connections.map((c) => [c.toolkitSlug, c]));
  return catalogSlugs().map((slug) => {
    const entry = COMPOSIO_CATALOG[slug];
    const conn = bySlug.get(slug);
    return {
      slug,
      name: entry.name,
      toolCount: entry.allowedTools.length,
      // conn.status is the DB text column (typed string); its values are the closed set
      // initializing|active|error|expired|disconnected — a subset of ToolkitStatus — so the cast is safe.
      status: (conn?.status ?? 'not_connected') as ToolkitStatus,
      linkUrl: conn?.status === 'initializing' ? (conn.linkUrl ?? null) : null,
      error: conn?.error ?? null,
    };
  });
}

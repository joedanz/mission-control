// ABOUTME: Static catalog of Composio long-tail toolkits MC supports connecting, with a curated
// ABOUTME: allow-list of tools per toolkit. Editorial data (not runtime state) — lives in code.

export type CatalogEntry = { name: string; allowedTools: string[] };

export const COMPOSIO_CATALOG: Record<string, CatalogEntry> = {
  linear: {
    name: 'Linear',
    allowedTools: [
      'LINEAR_LIST_LINEAR_TEAMS',
      'LINEAR_CREATE_LINEAR_ISSUE',
      'LINEAR_GET_LINEAR_ISSUE',
      'LINEAR_LIST_LINEAR_ISSUES',
    ],
  },
  slack: {
    name: 'Slack',
    allowedTools: [
      'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL',
      'SLACK_LIST_CONVERSATIONS',
      'SLACK_FETCH_CONVERSATION_HISTORY',
    ],
  },
};

/** Look up a catalog entry; null for an unknown slug. Object.hasOwn (not a bare `[]`/`in`) so an inherited
 *  Object.prototype member — getCatalogEntry('constructor') — doesn't leak a truthy function and crash callers
 *  with a TypeError instead of a clean "unknown toolkit". */
export function getCatalogEntry(slug: string): CatalogEntry | null {
  return Object.hasOwn(COMPOSIO_CATALOG, slug) ? COMPOSIO_CATALOG[slug] : null;
}

/** Sorted list of supported toolkit slugs. */
export function catalogSlugs(): string[] {
  return Object.keys(COMPOSIO_CATALOG).sort();
}

/** The allow-list to bind a toolkit's MCP server to: the curated list for a known toolkit, else `[]`.
 *  Composio expands `[]` to ALL of the toolkit's tools (verified live) — so any toolkit is connectable,
 *  with curated toolkits kept deliberately narrow. */
export function allowedToolsFor(slug: string): string[] {
  return getCatalogEntry(slug)?.allowedTools ?? [];
}

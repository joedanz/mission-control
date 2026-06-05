// ABOUTME: Unit tests for mcpServerViews — maps a project's mcp_connections rows (both sources) to
// ABOUTME: display views. Pure (no DB/network). Composio name falls back to slug; remotes carry url.
import { describe, it, expect } from 'vitest';
import { mcpServerViews } from '../lib/composio-view';
import type { McpConnection } from '../lib/db/schema';

function conn(partial: Partial<McpConnection>): McpConnection {
  return {
    id: 'id', projectId: 'p', source: 'composio', toolkitSlug: 'linear', userId: 'mc-proj-p',
    connectedAccountId: null, status: 'active', linkUrl: null, error: null,
    remoteName: null, remoteUrl: null, remoteHeaders: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...partial,
  } as McpConnection;
}

describe('mcpServerViews', () => {
  it('returns one view per connection row (composio + remote), no synthesized placeholders', () => {
    const views = mcpServerViews([
      conn({ toolkitSlug: 'linear', status: 'active' }),
      conn({ source: 'remote', toolkitSlug: null, userId: null, remoteName: 'docs', remoteUrl: 'https://r/mcp', status: 'active' }),
    ]);
    expect(views).toHaveLength(2);
    expect(views.map((v) => v.key).sort()).toEqual(['docs', 'linear']);
  });

  it('empty connections → empty list (no catalog placeholders)', () => {
    expect(mcpServerViews([])).toEqual([]);
  });

  it('composio view: known toolkit uses catalog name; unknown falls back to slug', () => {
    const [linear, gh] = mcpServerViews([
      conn({ toolkitSlug: 'linear' }),
      conn({ toolkitSlug: 'github' }),
    ]);
    expect(linear.source).toBe('composio');
    expect(linear.name).toBe('Linear');
    expect(gh.name).toBe('github'); // not in static catalog → slug
  });

  it('composio view exposes linkUrl ONLY while initializing', () => {
    const [init] = mcpServerViews([conn({ status: 'initializing', linkUrl: 'https://connect.composio.dev/link/x' })]);
    expect(init.linkUrl).toBe('https://connect.composio.dev/link/x');
    const [active] = mcpServerViews([conn({ status: 'active', linkUrl: 'https://connect.composio.dev/link/x' })]);
    expect(active.linkUrl).toBeNull();
  });

  it('remote view carries the url and never a linkUrl; passes error through', () => {
    const [v] = mcpServerViews([
      conn({ source: 'remote', toolkitSlug: null, userId: null, remoteName: 'docs', remoteUrl: 'https://r/mcp', status: 'active', error: 'boom' }),
    ]);
    expect(v.source).toBe('remote');
    expect(v.url).toBe('https://r/mcp');
    expect(v.linkUrl).toBeNull();
    expect(v.error).toBe('boom');
  });
});

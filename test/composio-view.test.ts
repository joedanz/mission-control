// ABOUTME: Unit tests for toolkitViews — overlays a project's connection rows onto the static catalog.
// ABOUTME: Pure (no DB/network); proves the not_connected fallback, status overlay, linkUrl gating, toolCount.

import { describe, it, expect } from 'vitest';
import { toolkitViews } from '../lib/composio-view';
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

describe('toolkitViews', () => {
  it('returns one view per catalog toolkit, sorted, all not_connected when no connections', () => {
    const views = toolkitViews([]);
    expect(views.map((v) => v.slug)).toEqual(['linear', 'slack']); // catalogSlugs() is sorted
    expect(views.every((v) => v.status === 'not_connected')).toBe(true);
    expect(views.every((v) => v.linkUrl === null && v.error === null)).toBe(true);
  });

  it('reports the catalog tool count and display name', () => {
    const [linear, slack] = toolkitViews([]);
    expect(linear.name).toBe('Linear');
    expect(linear.toolCount).toBe(4);
    expect(slack.name).toBe('Slack');
    expect(slack.toolCount).toBe(3);
  });

  it('overlays a connection status onto its toolkit', () => {
    const views = toolkitViews([conn({ toolkitSlug: 'linear', status: 'active' })]);
    expect(views.find((v) => v.slug === 'linear')!.status).toBe('active');
    expect(views.find((v) => v.slug === 'slack')!.status).toBe('not_connected');
  });

  it('exposes linkUrl ONLY while initializing', () => {
    const initializing = toolkitViews([conn({ toolkitSlug: 'linear', status: 'initializing', linkUrl: 'https://connect.composio.dev/link/x' })]);
    expect(initializing.find((v) => v.slug === 'linear')!.linkUrl).toBe('https://connect.composio.dev/link/x');
    const active = toolkitViews([conn({ toolkitSlug: 'linear', status: 'active', linkUrl: 'https://connect.composio.dev/link/x' })]);
    expect(active.find((v) => v.slug === 'linear')!.linkUrl).toBeNull(); // not surfaced once active
  });

  it('passes the connection error through', () => {
    const views = toolkitViews([conn({ toolkitSlug: 'slack', status: 'error', error: 'boom' })]);
    expect(views.find((v) => v.slug === 'slack')!.error).toBe('boom');
  });

  it('ignores remote-source rows (they are not catalog toolkits)', () => {
    const views = toolkitViews([
      conn({ source: 'remote', toolkitSlug: null, remoteName: 'docs', remoteUrl: 'https://r', status: 'active' }),
    ]);
    expect(views.every((v) => v.status === 'not_connected')).toBe(true); // the remote row didn't overlay anything
  });
});

// ABOUTME: Composio API client — pure helpers (user_id, status map) + fetch-mocked wrappers.
// ABOUTME: No network: global fetch is stubbed per case. CI-safe.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  deriveUserId, mapStatus, orphanedConnectedAccountId, transitionEvent,
  createAuthConfig, createMcpServer, initiateConnection, getConnectionStatus, deleteConnection,
  listToolkits,
  ComposioApiError,
} from '../lib/composio-api';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })));
}

describe('Composio API pure helpers', () => {
  it('derives a stable per-project user_id', () => {
    expect(deriveUserId('abc-123')).toBe('mc-proj-abc-123');
  });
  it('maps Composio statuses to our enum', () => {
    expect(mapStatus('ACTIVE')).toBe('active');
    expect(mapStatus('INITIALIZING')).toBe('initializing');
    expect(mapStatus('INITIATED')).toBe('initializing');
    expect(mapStatus('EXPIRED')).toBe('expired');
    expect(mapStatus('INACTIVE')).toBe('disconnected');
    expect(mapStatus('DISABLED')).toBe('disconnected');
    expect(mapStatus(null)).toBe('error');
    expect(mapStatus('weird')).toBe('error');
  });
  it('picks the orphaned connected_account to revoke on reconnect', () => {
    expect(orphanedConnectedAccountId('ca_old', 'ca_new')).toBe('ca_old');
    expect(orphanedConnectedAccountId('ca_same', 'ca_same')).toBeNull();
    expect(orphanedConnectedAccountId(null, 'ca_new')).toBeNull();
    expect(orphanedConnectedAccountId(undefined, 'ca_new')).toBeNull();
  });
  it('maps a connection status transition to an event (or null)', () => {
    expect(transitionEvent('proj', 'linear', 'active', 'active')).toBeNull();
    expect(transitionEvent('proj', 'linear', 'expired', 'active')).toEqual({
      level: 'info',
      summary: 'linear connection recovered — now active',
    });
    const expired = transitionEvent('proj', 'linear', 'active', 'expired');
    expect(expired?.level).toBe('warn');
    expect(expired?.summary).toContain('linear connection expired');
    expect(expired?.summary).toContain('mc composio connect proj linear');
    expect(transitionEvent('proj', 'slack', 'active', 'error')?.level).toBe('warn');
  });
});

describe('Composio API wrappers (mocked fetch)', () => {
  beforeEach(() => vi.stubEnv('COMPOSIO_API_KEY', 'ak_test'));
  it('createAuthConfig returns the new id', async () => {
    mockFetch(201, { auth_config: { id: 'ac_9' } });
    expect(await createAuthConfig('linear')).toBe('ac_9');
  });
  it('createMcpServer returns id + url', async () => {
    mockFetch(201, { id: 'srv_9', mcp_url: 'https://b/v3/mcp/srv_9' });
    expect(await createMcpServer('linear', 'ac_9', ['T'])).toEqual({ mcpServerId: 'srv_9', mcpUrl: 'https://b/v3/mcp/srv_9' });
  });
  it('initiateConnection returns redirect + connected account', async () => {
    mockFetch(201, { redirect_url: 'https://connect/x', connected_account_id: 'ca_9' });
    expect(await initiateConnection('ac_9', 'mc-proj-x')).toEqual({ redirectUrl: 'https://connect/x', connectedAccountId: 'ca_9' });
  });
  it('getConnectionStatus returns the raw status', async () => {
    mockFetch(200, { status: 'ACTIVE' });
    expect(await getConnectionStatus('ca_9')).toBe('ACTIVE');
  });
  it('throws ComposioApiError on a non-2xx', async () => {
    mockFetch(400, { error: 'bad' });
    await expect(getConnectionStatus('ca_9')).rejects.toBeInstanceOf(ComposioApiError);
  });
  it('throws when COMPOSIO_API_KEY is unset', async () => {
    vi.stubEnv('COMPOSIO_API_KEY', '');
    await expect(getConnectionStatus('ca_9')).rejects.toBeInstanceOf(ComposioApiError);
  });
  it('deleteConnection issues a DELETE to the connected account', async () => {
    mockFetch(200, {});
    await deleteConnection('ca_9');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/connected_accounts/ca_9'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('listToolkits parses items into summaries', async () => {
    mockFetch(200, {
      items: [
        { slug: 'github', name: 'GitHub', meta: { tools_count: 823, description: 'Git host', categories: [{ id: 'dev', name: 'Developer Tools' }] } },
        { slug: 'gmail', name: 'Gmail', meta: { tools_count: 61, description: 'Email', categories: [{ id: 'email', name: 'email' }] } },
      ],
      total_items: 1043,
    });
    const out = await listToolkits();
    expect(out).toEqual([
      { slug: 'github', name: 'GitHub', description: 'Git host', toolCount: 823, categories: ['Developer Tools'] },
      { slug: 'gmail', name: 'Gmail', description: 'Email', toolCount: 61, categories: ['email'] },
    ]);
  });

  it('listToolkits tolerates missing meta fields', async () => {
    mockFetch(200, { items: [{ slug: 'bare', name: 'Bare' }] });
    expect(await listToolkits()).toEqual([{ slug: 'bare', name: 'Bare', description: '', toolCount: 0, categories: [] }]);
  });

  it('listToolkits passes search + limit as query params', async () => {
    mockFetch(200, { items: [] });
    await listToolkits({ search: 'git', limit: 25 });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/toolkits?'), expect.anything());
    const url = (fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('search=git');
    expect(url).toContain('limit=25');
  });

  it('listToolkits defaults limit to 50 when omitted', async () => {
    mockFetch(200, { items: [] });
    await listToolkits();
    const url = (fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('limit=50');
    expect(url).not.toContain('search=');
  });
});

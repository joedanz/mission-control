// ABOUTME: Composio API client — pure helpers (user_id, status map) + fetch-mocked wrappers.
// ABOUTME: No network: global fetch is stubbed per case. CI-safe.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  deriveUserId, mapStatus,
  createAuthConfig, createMcpServer, initiateConnection, getConnectionStatus, deleteConnection,
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
});

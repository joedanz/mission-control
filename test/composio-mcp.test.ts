// ABOUTME: Pure tests for the Composio mcpServers builder — key naming, URL construction, encoding.

import { describe, it, expect } from 'vitest';
import { composioServerKey, buildConnectionMcpServers } from '../lib/composio-mcp';

describe('composioServerKey', () => {
  it('prefixes the toolkit slug', () => {
    expect(composioServerKey('linear')).toBe('composio-linear');
  });
});

describe('buildConnectionMcpServers (pure)', () => {
  it('builds an http server with a user_id query + api-key placeholder', () => {
    const map = buildConnectionMcpServers([
      { toolkitSlug: 'linear', userId: 'mc-proj-abc', mcpUrl: 'https://backend.composio.dev/v3/mcp/srv1' },
    ]);
    expect(map).toEqual({
      'composio-linear': {
        type: 'http',
        url: 'https://backend.composio.dev/v3/mcp/srv1?user_id=mc-proj-abc',
        headers: { 'x-api-key': '${COMPOSIO_API_KEY}' },
      },
    });
  });

  it('emits one entry per row, keyed by toolkit', () => {
    const map = buildConnectionMcpServers([
      { toolkitSlug: 'linear', userId: 'u1', mcpUrl: 'https://x/v3/mcp/a' },
      { toolkitSlug: 'slack', userId: 'u1', mcpUrl: 'https://x/v3/mcp/b' },
    ]);
    expect(Object.keys(map).sort()).toEqual(['composio-linear', 'composio-slack']);
    expect(map['composio-linear'].url).toBe('https://x/v3/mcp/a?user_id=u1');
    expect(map['composio-linear'].headers).toEqual({ 'x-api-key': '${COMPOSIO_API_KEY}' });
    expect(map['composio-slack'].url).toBe('https://x/v3/mcp/b?user_id=u1');
    expect(map['composio-slack'].headers).toEqual({ 'x-api-key': '${COMPOSIO_API_KEY}' });
  });

  it('lets the last row win on a duplicate toolkitSlug', () => {
    const map = buildConnectionMcpServers([
      { toolkitSlug: 'linear', userId: 'first', mcpUrl: 'https://x/v3/mcp/a' },
      { toolkitSlug: 'linear', userId: 'second', mcpUrl: 'https://x/v3/mcp/a' },
    ]);
    expect(Object.keys(map)).toEqual(['composio-linear']);
    expect(map['composio-linear'].url).toBe('https://x/v3/mcp/a?user_id=second');
  });

  it('url-encodes the user_id', () => {
    const map = buildConnectionMcpServers([{ toolkitSlug: 'linear', userId: 'a/b c', mcpUrl: 'https://x/v3/mcp/a' }]);
    expect(map['composio-linear'].url).toBe('https://x/v3/mcp/a?user_id=a%2Fb%20c');
  });

  it('returns an empty map for no rows', () => {
    expect(buildConnectionMcpServers([])).toEqual({});
  });
});

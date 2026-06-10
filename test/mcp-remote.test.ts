// ABOUTME: Pure remote-MCP helpers — build the mcpServers entry + validate add-remote input. No DB/network.

import { describe, it, expect } from 'vitest';
import { buildRemoteMcpServers, validateRemoteInput } from '../lib/mcp-remote';
import { ValidationError } from '../lib/validation';

describe('buildRemoteMcpServers', () => {
  it('emits one http entry per row, keyed by remoteName, headers preserved verbatim', () => {
    const map = buildRemoteMcpServers([
      { remoteName: 'docs', remoteUrl: 'https://a/sse', remoteHeaders: { Authorization: 'Bearer ${T}' } },
      { remoteName: 'wiki', remoteUrl: 'https://b/mcp', remoteHeaders: null },
    ]);
    expect(map).toEqual({
      docs: { type: 'http', url: 'https://a/sse', headers: { Authorization: 'Bearer ${T}' } },
      wiki: { type: 'http', url: 'https://b/mcp' },
    });
  });

  it('omits the headers key when the row has an empty header map', () => {
    const map = buildRemoteMcpServers([{ remoteName: 'docs', remoteUrl: 'https://a', remoteHeaders: {} }]);
    expect(map.docs).toEqual({ type: 'http', url: 'https://a' });
  });
});

describe('validateRemoteInput', () => {
  it('accepts a valid name + https URL + ${ENV} headers', () => {
    const out = validateRemoteInput({ name: ' docs ', url: 'https://a/sse', headers: { Authorization: 'Bearer ${T}' } });
    expect(out).toEqual({ name: 'docs', url: 'https://a/sse', headers: { Authorization: 'Bearer ${T}' } });
  });

  it('rejects an empty name', () => {
    expect(() => validateRemoteInput({ name: '  ', url: 'https://a', headers: {} })).toThrow(ValidationError);
  });

  it('rejects a non-http(s) URL', () => {
    expect(() => validateRemoteInput({ name: 'x', url: 'ftp://a', headers: {} })).toThrow(ValidationError);
    expect(() => validateRemoteInput({ name: 'x', url: 'not a url', headers: {} })).toThrow(ValidationError);
  });

  it('rejects a header value with no ${ENV} placeholder (would persist a literal secret)', () => {
    expect(() => validateRemoteInput({ name: 'x', url: 'https://a', headers: { Authorization: 'Bearer sk-raw-secret' } })).toThrow(ValidationError);
  });

  it('rejects a URL with a LITERAL credential query param (would persist a secret in remoteUrl) (M20)', () => {
    expect(() => validateRemoteInput({ name: 'x', url: 'https://s/mcp?api_key=sk-literal-123', headers: {} })).toThrow(ValidationError);
    expect(() => validateRemoteInput({ name: 'x', url: 'https://s/mcp?token=abc', headers: {} })).toThrow(ValidationError);
  });

  it('accepts a URL whose credential query param is an ${ENV} placeholder (resolved at spawn) (M20)', () => {
    const out = validateRemoteInput({ name: 'x', url: 'https://s/mcp?api_key=${MY_TOKEN}', headers: {} });
    expect(out.url).toBe('https://s/mcp?api_key=${MY_TOKEN}'); // stored verbatim — no literal secret
  });

  it('allows a non-credential query param with a literal value', () => {
    expect(() => validateRemoteInput({ name: 'x', url: 'https://s/mcp?page=2&limit=10', headers: {} })).not.toThrow();
  });
});

// ABOUTME: Pins the Composio Linear MCP contract — that MC's profile validator accepts the hosted-MCP
// ABOUTME: shape (http + url + x-api-key header) and the daemon resolves ${COMPOSIO_API_KEY} into the header.
// ABOUTME: CI-safe + pure (no network, no DB): guards the linchpin the whole Integrations reshape depends on.

import { describe, it, expect } from 'vitest';
import type { McpServerConfig } from '../lib/db/schema';
import { validateProfile, type EffectiveProfile } from '../lib/profiles';
import { resolveMcpConfigJson, MissingEnvError } from '../daemon/render-profile';

const COMPOSIO_LINEAR: Record<string, McpServerConfig> = {
  'composio-linear': {
    type: 'http',
    url: 'https://backend.composio.dev/v3/mcp/srv_test123?user_id=user_smoke',
    headers: { 'x-api-key': '${COMPOSIO_API_KEY}' },
  },
};

function profileWith(mcpServers: Record<string, McpServerConfig> | null): EffectiveProfile {
  return { runtime: 'claude-code', mcpServers };
}

describe('Composio Linear MCP contract', () => {
  it('validateProfile accepts the hosted-MCP http shape', () => {
    expect(() => validateProfile(profileWith(COMPOSIO_LINEAR))).not.toThrow();
  });

  it('validateProfile rejects an http server with no url (guard has teeth)', () => {
    const bad: Record<string, McpServerConfig> = {
      'composio-linear': { type: 'http', headers: { 'x-api-key': '${COMPOSIO_API_KEY}' } },
    };
    expect(() => validateProfile(profileWith(bad))).toThrow(/requires a url/);
  });

  it('resolveMcpConfigJson injects COMPOSIO_API_KEY into the x-api-key header', () => {
    const json = resolveMcpConfigJson(COMPOSIO_LINEAR, { COMPOSIO_API_KEY: 'sk_live_abc' });
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json as string) as { mcpServers: Record<string, McpServerConfig> };
    expect(parsed.mcpServers['composio-linear'].headers!['x-api-key']).toBe('sk_live_abc');
    // url is returned verbatim — placeholders resolve in env/headers only, not the url.
    expect(parsed.mcpServers['composio-linear'].url).toBe(COMPOSIO_LINEAR['composio-linear'].url);
  });

  it('resolveMcpConfigJson throws MissingEnvError when COMPOSIO_API_KEY is unset', () => {
    expect.assertions(2);
    try {
      resolveMcpConfigJson(COMPOSIO_LINEAR, {});
      throw new Error('expected MissingEnvError');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingEnvError);
      expect((e as MissingEnvError).varName).toBe('COMPOSIO_API_KEY');
    }
  });
});

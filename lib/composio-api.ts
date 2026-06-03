// ABOUTME: Composio v3 HTTP client (auth-config / MCP-server / connected-account) + pure helpers
// ABOUTME: (user_id derivation, status mapping, per-user MCP URL). No DB. Vercel-safe fetch, no SDK.

const COMPOSIO_BASE = 'https://backend.composio.dev/api/v3';

export class ComposioApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'ComposioApiError';
  }
}

/** Stable Composio user_id for a project (per-project connection isolation). */
export function deriveUserId(projectId: string): string {
  return `mc-proj-${projectId}`;
}

/** Per-user MCP URL = the toolkit's server base + ?user_id=. Placeholders never go in the URL. */
export function deriveMcpUrl(mcpUrlBase: string, userId: string): string {
  return `${mcpUrlBase}?user_id=${encodeURIComponent(userId)}`;
}

/** Map Composio's connected-account status to our lowercase enum. */
export function mapStatus(raw: string | undefined | null): string {
  switch ((raw ?? '').toUpperCase()) {
    case 'ACTIVE':
      return 'active';
    case 'INITIALIZING':
    case 'INITIATED':
      return 'initializing';
    case 'EXPIRED':
      return 'expired';
    case 'INACTIVE':
    case 'DISABLED':
      return 'disconnected';
    default:
      return 'error';
  }
}

async function composioFetch(path: string, init?: RequestInit): Promise<unknown> {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key) throw new ComposioApiError('COMPOSIO_API_KEY is not set');
  const res = await fetch(`${COMPOSIO_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(init?.headers ?? {}), 'x-api-key': key },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ComposioApiError(`Composio ${res.status}: ${body.slice(0, 300)}`, res.status);
  }
  return res.json();
}

/** Create a managed-OAuth auth config for a toolkit → its id. */
export async function createAuthConfig(toolkitSlug: string): Promise<string> {
  const j = (await composioFetch('/auth_configs', {
    method: 'POST',
    body: JSON.stringify({ toolkit: { slug: toolkitSlug }, auth_config: { type: 'use_composio_managed_auth', name: `mc-${toolkitSlug}` } }),
  })) as { auth_config?: { id?: string } };
  const id = j.auth_config?.id;
  if (!id) throw new ComposioApiError('auth config create returned no id');
  return id;
}

/** Create an MCP server bound to a toolkit's auth config + allow-list → { mcpServerId, mcpUrl }. */
export async function createMcpServer(
  toolkitSlug: string,
  authConfigId: string,
  allowedTools: string[],
): Promise<{ mcpServerId: string; mcpUrl: string }> {
  const j = (await composioFetch('/mcp/servers', {
    method: 'POST',
    body: JSON.stringify({ name: `mc-${toolkitSlug}`, auth_config_ids: [authConfigId], allowed_tools: allowedTools }),
  })) as { id?: string; mcp_url?: string };
  if (!j.id || !j.mcp_url) throw new ComposioApiError('mcp server create returned no id/url');
  return { mcpServerId: j.id, mcpUrl: j.mcp_url };
}

/** Begin a hosted-OAuth connection for a user → { redirectUrl, connectedAccountId }. */
export async function initiateConnection(
  authConfigId: string,
  userId: string,
): Promise<{ redirectUrl: string; connectedAccountId: string }> {
  const j = (await composioFetch('/connected_accounts/link', {
    method: 'POST',
    body: JSON.stringify({ auth_config_id: authConfigId, user_id: userId }),
  })) as { redirect_url?: string; connected_account_id?: string };
  if (!j.redirect_url || !j.connected_account_id) throw new ComposioApiError('link returned no redirect_url/connected_account_id');
  return { redirectUrl: j.redirect_url, connectedAccountId: j.connected_account_id };
}

/** Current Composio status for a connected account (raw, uppercase). */
export async function getConnectionStatus(connectedAccountId: string): Promise<string> {
  const j = (await composioFetch(`/connected_accounts/${connectedAccountId}`)) as { status?: string };
  return j.status ?? '';
}

export async function deleteConnection(connectedAccountId: string): Promise<void> {
  await composioFetch(`/connected_accounts/${connectedAccountId}`, { method: 'DELETE' });
}

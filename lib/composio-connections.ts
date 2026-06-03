// ABOUTME: Composio connection lifecycle — composes the DB store + the v3 API client into
// ABOUTME: ensureToolkit / connectStart / connectPoll / listConnections / disconnect. Per-project.

import { getCatalogEntry } from './composio-catalog';
import { getProjectBySlug } from './queries';
import { getToolkitRow, upsertToolkitRow, getConnection, listConnectionsByProject, upsertConnection, setConnectionStatus } from './composio-store';
import { createAuthConfig, createMcpServer, initiateConnection, getConnectionStatus, deleteConnection, deriveUserId, mapStatus } from './composio-api';
import type { ComposioConnection } from './db/schema';

export class ComposioConnectionError extends Error {}

/** Ensure the shared auth-config + MCP server exist for a toolkit; cache + return their ids. Idempotent
 *  via the composio_toolkits cache (created once per toolkit). */
export async function ensureToolkit(slug: string): Promise<{ authConfigId: string; mcpServerId: string; mcpUrl: string }> {
  const entry = getCatalogEntry(slug);
  if (!entry) throw new ComposioConnectionError(`unknown toolkit: ${slug}`);
  let row = await getToolkitRow(slug);
  if (!row?.authConfigId) {
    const authConfigId = await createAuthConfig(slug);
    row = await upsertToolkitRow(slug, { authConfigId });
  }
  if (!row.mcpServerId || !row.mcpUrl) {
    const { mcpServerId, mcpUrl } = await createMcpServer(slug, row.authConfigId!, entry.allowedTools);
    row = await upsertToolkitRow(slug, { mcpServerId, mcpUrl });
  }
  return { authConfigId: row.authConfigId!, mcpServerId: row.mcpServerId!, mcpUrl: row.mcpUrl! };
}

/** Begin connecting a project to a toolkit: ensure resources, start the hosted OAuth link, store the
 *  in-flight connection. Returns the link the operator opens to authorize. */
export async function connectStart(projectSlug: string, toolkitSlug: string): Promise<{ linkUrl: string; connection: ComposioConnection }> {
  const project = await getProjectBySlug(projectSlug);
  if (!project) throw new ComposioConnectionError(`unknown project: ${projectSlug}`);
  if (!getCatalogEntry(toolkitSlug)) throw new ComposioConnectionError(`unknown toolkit: ${toolkitSlug}`);
  const { authConfigId } = await ensureToolkit(toolkitSlug);
  const userId = deriveUserId(project.id);
  const { redirectUrl, connectedAccountId } = await initiateConnection(authConfigId, userId);
  const connection = await upsertConnection(project.id, toolkitSlug, {
    userId, connectedAccountId, status: 'initializing', linkUrl: redirectUrl, error: null,
  });
  return { linkUrl: redirectUrl, connection };
}

/** Poll Composio for the current status of a project's toolkit connection; persist + return it. */
export async function connectPoll(projectSlug: string, toolkitSlug: string): Promise<ComposioConnection> {
  const project = await getProjectBySlug(projectSlug);
  if (!project) throw new ComposioConnectionError(`unknown project: ${projectSlug}`);
  const conn = await getConnection(project.id, toolkitSlug);
  if (!conn?.connectedAccountId) throw new ComposioConnectionError(`no in-flight connection for ${projectSlug}/${toolkitSlug}`);
  const raw = await getConnectionStatus(conn.connectedAccountId);
  const updated = await setConnectionStatus(conn.id, mapStatus(raw));
  return updated ?? conn;
}

export async function listConnections(projectSlug: string): Promise<ComposioConnection[]> {
  const project = await getProjectBySlug(projectSlug);
  if (!project) throw new ComposioConnectionError(`unknown project: ${projectSlug}`);
  return listConnectionsByProject(project.id);
}

/** Revoke at Composio + mark the connection disconnected. */
export async function disconnect(projectSlug: string, toolkitSlug: string): Promise<ComposioConnection> {
  const project = await getProjectBySlug(projectSlug);
  if (!project) throw new ComposioConnectionError(`unknown project: ${projectSlug}`);
  const conn = await getConnection(project.id, toolkitSlug);
  if (!conn) throw new ComposioConnectionError(`no connection for ${projectSlug}/${toolkitSlug}`);
  if (conn.connectedAccountId) await deleteConnection(conn.connectedAccountId);
  const updated = await setConnectionStatus(conn.id, 'disconnected');
  return updated ?? conn;
}

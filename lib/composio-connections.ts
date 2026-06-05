// ABOUTME: Composio connection lifecycle — composes the DB store + the v3 API client into
// ABOUTME: ensureToolkit / connectStart / connectPoll / listConnections / disconnect. Per-project.

import { allowedToolsFor } from './composio-catalog';
import { getProjectIdBySlug } from './queries';
import { getToolkitRow, upsertToolkitRow, getConnection, listConnectionsByProject, upsertConnection, setConnectionStatus } from './composio-store';
import { createAuthConfig, createMcpServer, initiateConnection, getConnectionStatus, deleteConnection, deriveUserId, mapStatus, orphanedConnectedAccountId, transitionEvent, ComposioApiError } from './composio-api';
import { buildConnectionMcpServers, type ConnectionMcpRow } from './composio-mcp';
import { createEvent } from './mutations';
import type { McpConnection, ConnectionStatus, McpServerConfig } from './db/schema';
import { NotFoundError } from './validation';

/** Ensure the shared auth-config + MCP server exist for a toolkit; cache + return their ids. Idempotent
 *  via the composio_toolkits cache (created once per toolkit). */
export async function ensureToolkit(slug: string): Promise<{ authConfigId: string; mcpServerId: string; mcpUrl: string }> {
  let row = await getToolkitRow(slug);
  if (!row?.authConfigId) {
    const authConfigId = await createAuthConfig(slug); // Composio rejects an unknown/no-auth slug with a 400 → ComposioApiError
    row = await upsertToolkitRow(slug, { authConfigId });
  }
  if (!row.mcpServerId || !row.mcpUrl) {
    const { mcpServerId, mcpUrl } = await createMcpServer(slug, row.authConfigId!, allowedToolsFor(slug));
    row = await upsertToolkitRow(slug, { mcpServerId, mcpUrl });
  }
  return { authConfigId: row.authConfigId!, mcpServerId: row.mcpServerId!, mcpUrl: row.mcpUrl! };
}

/** Begin connecting a project to a toolkit: ensure resources, start the hosted OAuth link, store the
 *  in-flight connection. Returns the link the operator opens to authorize. */
export async function connectStart(projectSlug: string, toolkitSlug: string): Promise<{ linkUrl: string; connection: McpConnection }> {
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  const { authConfigId } = await ensureToolkit(toolkitSlug);
  const existing = await getConnection(projectId, toolkitSlug); // capture the prior account before the upsert overwrites it
  const userId = deriveUserId(projectId);
  const { redirectUrl, connectedAccountId } = await initiateConnection(authConfigId, userId);
  const connection = await upsertConnection(projectId, toolkitSlug, {
    userId, connectedAccountId, status: 'initializing', linkUrl: redirectUrl, error: null,
  });
  // Revoke the prior connected_account so reconnects don't leak it at Composio. Best-effort: the new
  // connection already succeeded, so a cleanup failure must not fail the reconnect (worst case the old
  // account lingers — today's status quo).
  const orphaned = orphanedConnectedAccountId(existing?.connectedAccountId, connectedAccountId);
  if (orphaned) {
    try {
      await deleteConnection(orphaned);
    } catch (e) {
      console.warn(`composio reconnect: failed to delete orphaned account ${orphaned}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { linkUrl: redirectUrl, connection };
}

/** Poll Composio for the current status of a project's toolkit connection; persist + return it. */
export async function connectPoll(projectSlug: string, toolkitSlug: string): Promise<McpConnection> {
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  const conn = await getConnection(projectId, toolkitSlug);
  if (!conn?.connectedAccountId) throw new NotFoundError('connection', `${projectSlug}/${toolkitSlug}`, 'no in-flight connection');
  const raw = await getConnectionStatus(conn.connectedAccountId);
  const updated = await setConnectionStatus(conn.id, mapStatus(raw));
  return updated ?? conn;
}

export async function listConnections(projectSlug: string): Promise<McpConnection[]> {
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  return listConnectionsByProject(projectId);
}

/** Revoke at Composio + mark the connection disconnected. */
export async function disconnect(projectSlug: string, toolkitSlug: string): Promise<McpConnection> {
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  const conn = await getConnection(projectId, toolkitSlug);
  if (!conn) throw new NotFoundError('connection', `${projectSlug}/${toolkitSlug}`);
  if (conn.connectedAccountId) {
    try {
      await deleteConnection(conn.connectedAccountId);
    } catch (e) {
      // Already gone at Composio (expired/revoked) → still mark disconnected locally.
      if (!(e instanceof ComposioApiError && e.status === 404)) throw e;
    }
  }
  const updated = await setConnectionStatus(conn.id, 'disconnected');
  return updated ?? conn;
}

/** Resolve a project's ACTIVE Composio connections into an mcpServers map for a spawned agent. Lists
 *  the project's connections, keeps only status==='active', joins each toolkit's cached mcpUrl, and
 *  builds the map. An active connection whose toolkit cache row has no mcpUrl is skipped (defensive —
 *  ensureToolkit populates it before connect). */
export async function resolveProjectMcpServers(projectSlug: string): Promise<Record<string, McpServerConfig>> {
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  const active = (await listConnectionsByProject(projectId)).filter((c) => c.status === 'active');
  const joined = await Promise.all(
    active.map(async (c) => {
      const toolkit = await getToolkitRow(c.toolkitSlug);
      return toolkit?.mcpUrl ? { toolkitSlug: c.toolkitSlug, userId: c.userId, mcpUrl: toolkit.mcpUrl } : null;
    }),
  );
  const rows: ConnectionMcpRow[] = joined.filter((r): r is ConnectionMcpRow => r !== null);
  return buildConnectionMcpServers(rows);
}

export type ConnectionRefresh = { toolkitSlug: string; from: ConnectionStatus; to: ConnectionStatus; changed: boolean };

/** Re-poll every linked connection of a project against Composio; persist changes and emit a
 *  composio.connection_changed event per transition (best-effort). A per-connection poll failure is
 *  skipped (status left unchanged) so a transient Composio blip never clobbers a known status. */
export async function refreshConnections(projectSlug: string): Promise<ConnectionRefresh[]> {
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  const conns = await listConnectionsByProject(projectId);
  const results: ConnectionRefresh[] = [];
  for (const conn of conns) {
    if (!conn.connectedAccountId) continue; // never linked → nothing to poll
    const from = conn.status;
    let to = from;
    try {
      to = mapStatus(await getConnectionStatus(conn.connectedAccountId));
    } catch (e) {
      console.warn(`composio refresh: poll failed for ${conn.toolkitSlug} (${conn.connectedAccountId}): ${e instanceof Error ? e.message : e}`);
      results.push({ toolkitSlug: conn.toolkitSlug, from, to: from, changed: false });
      continue;
    }
    if (to !== from) {
      await setConnectionStatus(conn.id, to);
      const ev = transitionEvent(projectSlug, conn.toolkitSlug, from, to);
      if (ev) {
        try {
          await createEvent({ type: 'composio.connection_changed', projectId, level: ev.level, summary: ev.summary });
        } catch (err) {
          console.warn(`composio refresh: event write failed for ${conn.toolkitSlug}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    results.push({ toolkitSlug: conn.toolkitSlug, from, to, changed: to !== from });
  }
  return results;
}

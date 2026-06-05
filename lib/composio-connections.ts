// ABOUTME: Composio connection lifecycle — composes the DB store + the v3 API client into
// ABOUTME: ensureToolkit / connectStart / connectPoll / listConnections / disconnect. Per-project.

import { allowedToolsFor } from './composio-catalog';
import { getProjectIdBySlug } from './queries';
import { getToolkitRow, upsertToolkitRow, getConnection, listConnectionsByProject, upsertConnection, setConnectionStatus, upsertRemoteConnection, deleteRemoteConnection } from './composio-store';
import { createAuthConfig, createMcpServer, initiateConnection, getConnectionStatus, deleteConnection, deriveUserId, mapStatus, orphanedConnectedAccountId, transitionEvent, ComposioApiError } from './composio-api';
import { buildConnectionMcpServers, type ConnectionMcpRow } from './composio-mcp';
import { buildRemoteMcpServers, validateRemoteInput, type RemoteMcpRow } from './mcp-remote';
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

/** Attach a remote-http MCP server to a project (no OAuth). Validates input, then upserts a remote row
 *  (idempotent on name). The server is immediately active. */
export async function addRemote(
  projectSlug: string,
  input: { name: string; url: string; headers: Record<string, string> },
): Promise<McpConnection> {
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  const { name, url, headers } = validateRemoteInput(input);
  return upsertRemoteConnection(projectId, { remoteName: name, remoteUrl: url, remoteHeaders: headers });
}

/** Detach a remote MCP server by name. NotFoundError if no such remote row. */
export async function removeRemote(projectSlug: string, name: string): Promise<McpConnection> {
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  const removed = await deleteRemoteConnection(projectId, name);
  if (!removed) throw new NotFoundError('remote connection', `${projectSlug}/${name}`);
  return removed;
}

/** Resolve a project's ACTIVE MCP connections into an mcpServers map for a spawned agent. Unions both
 *  sources: composio rows join each toolkit's cached mcpUrl (an active composio row whose cache row has
 *  no mcpUrl is skipped — defensive; ensureToolkit populates it before connect), and remote rows emit a
 *  direct http entry. On a key collision a remote row wins over a composio one (it's spread last). */
export async function resolveProjectMcpServers(projectSlug: string): Promise<Record<string, McpServerConfig>> {
  const projectId = await getProjectIdBySlug(projectSlug);
  if (!projectId) throw new NotFoundError('project', projectSlug);
  const active = (await listConnectionsByProject(projectId)).filter((c) => c.status === 'active');
  // composio rows → join each toolkit's cached mcpUrl (a row with no cached url, or missing slug/user, is skipped)
  const joined = await Promise.all(
    active
      .filter((c) => c.source === 'composio')
      .map(async (c) => {
        if (!c.toolkitSlug || !c.userId) return null;
        const toolkit = await getToolkitRow(c.toolkitSlug);
        return toolkit?.mcpUrl ? { toolkitSlug: c.toolkitSlug, userId: c.userId, mcpUrl: toolkit.mcpUrl } : null;
      }),
  );
  const composioRows: ConnectionMcpRow[] = joined.filter((r): r is ConnectionMcpRow => r !== null);
  // remote rows → emit directly (no cache/network); a malformed row missing name/url is skipped
  const remoteRows: RemoteMcpRow[] = active
    .filter((c) => c.source === 'remote' && c.remoteName && c.remoteUrl)
    .map((c) => ({ remoteName: c.remoteName!, remoteUrl: c.remoteUrl!, remoteHeaders: c.remoteHeaders }));
  return { ...buildConnectionMcpServers(composioRows), ...buildRemoteMcpServers(remoteRows) };
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
    if (!conn.connectedAccountId || !conn.toolkitSlug) continue; // never-linked or remote rows → nothing to poll
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

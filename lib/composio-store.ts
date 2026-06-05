// ABOUTME: DB CRUD for composio_toolkits (cached shared resources) + mcp_connections (per
// ABOUTME: project+toolkit). No Composio network calls — the DB-testable seam under the orchestration.

import { eq, and, sql } from 'drizzle-orm';
import { db } from './db/index';
import { composioToolkits, mcpConnections, type ComposioToolkit, type McpConnection, type ConnectionStatus } from './db/schema';

export async function getToolkitRow(slug: string): Promise<ComposioToolkit | null> {
  const rows = await db.select().from(composioToolkits).where(eq(composioToolkits.slug, slug)).limit(1);
  return rows[0] ?? null;
}

/** Upsert the cached Composio resource ids for a toolkit (only the provided fields change). */
export async function upsertToolkitRow(
  slug: string,
  patch: { authConfigId?: string; mcpServerId?: string; mcpUrl?: string },
): Promise<ComposioToolkit> {
  const rows = await db
    .insert(composioToolkits)
    .values({ slug, ...patch })
    .onConflictDoUpdate({
      target: composioToolkits.slug,
      set: { ...patch, updatedAt: new Date() },
    })
    .returning();
  return rows[0];
}

export async function getConnection(projectId: string, toolkitSlug: string): Promise<McpConnection | null> {
  const rows = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.projectId, projectId), eq(mcpConnections.toolkitSlug, toolkitSlug)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listConnectionsByProject(projectId: string): Promise<McpConnection[]> {
  return db.select().from(mcpConnections).where(eq(mcpConnections.projectId, projectId));
}

/** Create or update the (project, toolkit) connection row. Only provided fields change on conflict. */
export async function upsertConnection(
  projectId: string,
  toolkitSlug: string,
  patch: { userId: string; connectedAccountId?: string | null; status?: ConnectionStatus; linkUrl?: string | null; error?: string | null },
): Promise<McpConnection> {
  const rows = await db
    .insert(mcpConnections)
    .values({ projectId, toolkitSlug, ...patch })
    .onConflictDoUpdate({
      target: [mcpConnections.projectId, mcpConnections.toolkitSlug],
      set: {
        ...(patch.connectedAccountId !== undefined && { connectedAccountId: patch.connectedAccountId }),
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.linkUrl !== undefined && { linkUrl: patch.linkUrl }),
        ...(patch.error !== undefined && { error: patch.error }),
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows[0];
}

export async function setConnectionStatus(
  id: string,
  status: ConnectionStatus,
  error: string | null = null,
): Promise<McpConnection | null> {
  const rows = await db
    .update(mcpConnections)
    .set({ status, error, updatedAt: new Date() })
    .where(eq(mcpConnections.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function getRemoteConnection(projectId: string, remoteName: string): Promise<McpConnection | null> {
  const rows = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.projectId, projectId), eq(mcpConnections.source, 'remote'), eq(mcpConnections.remoteName, remoteName)))
    .limit(1);
  return rows[0] ?? null;
}

/** Upsert a remote-source MCP server row (source='remote', status pinned 'active'). Idempotent on
 *  (project, remote_name) via the partial unique index — a re-add updates url + headers. */
export async function upsertRemoteConnection(
  projectId: string,
  patch: { remoteName: string; remoteUrl: string; remoteHeaders: Record<string, string> },
): Promise<McpConnection> {
  const rows = await db
    .insert(mcpConnections)
    .values({
      projectId,
      source: 'remote',
      status: 'active',
      remoteName: patch.remoteName,
      remoteUrl: patch.remoteUrl,
      remoteHeaders: patch.remoteHeaders,
    })
    .onConflictDoUpdate({
      target: [mcpConnections.projectId, mcpConnections.remoteName],
      targetWhere: sql`source = 'remote'`,
      set: { remoteUrl: patch.remoteUrl, remoteHeaders: patch.remoteHeaders, updatedAt: new Date() },
    })
    .returning();
  return rows[0];
}

export async function deleteRemoteConnection(projectId: string, remoteName: string): Promise<McpConnection | null> {
  const rows = await db
    .delete(mcpConnections)
    .where(and(eq(mcpConnections.projectId, projectId), eq(mcpConnections.source, 'remote'), eq(mcpConnections.remoteName, remoteName)))
    .returning();
  return rows[0] ?? null;
}

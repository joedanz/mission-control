// ABOUTME: DB CRUD for composio_toolkits (cached shared resources) + composio_connections (per
// ABOUTME: project+toolkit). No Composio network calls — the DB-testable seam under the orchestration.

import { eq, and } from 'drizzle-orm';
import { db } from './db/index';
import { composioToolkits, composioConnections, type ComposioToolkit, type ComposioConnection } from './db/schema';

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

export async function getConnection(projectId: string, toolkitSlug: string): Promise<ComposioConnection | null> {
  const rows = await db
    .select()
    .from(composioConnections)
    .where(and(eq(composioConnections.projectId, projectId), eq(composioConnections.toolkitSlug, toolkitSlug)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listConnectionsByProject(projectId: string): Promise<ComposioConnection[]> {
  return db.select().from(composioConnections).where(eq(composioConnections.projectId, projectId));
}

/** Create or update the (project, toolkit) connection row. Only provided fields change on conflict. */
export async function upsertConnection(
  projectId: string,
  toolkitSlug: string,
  patch: { userId: string; connectedAccountId?: string | null; status?: string; linkUrl?: string | null; error?: string | null },
): Promise<ComposioConnection> {
  const rows = await db
    .insert(composioConnections)
    .values({ projectId, toolkitSlug, ...patch })
    .onConflictDoUpdate({
      target: [composioConnections.projectId, composioConnections.toolkitSlug],
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
  status: string,
  error: string | null = null,
): Promise<ComposioConnection | null> {
  const rows = await db
    .update(composioConnections)
    .set({ status, error, updatedAt: new Date() })
    .where(eq(composioConnections.id, id))
    .returning();
  return rows[0] ?? null;
}

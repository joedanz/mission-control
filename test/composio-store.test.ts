// ABOUTME: composio_store DB round-trips against real Neon — toolkit cache upsert, connection
// ABOUTME: upsert/list/status, and the (project_id, toolkit_slug) unique constraint. Self-cleaning.

import { describe, it, expect, afterEach } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, composioToolkits } from '../lib/db/schema';
import { createProject } from '../lib/mutations';
import {
  getToolkitRow, upsertToolkitRow,
  getConnection, listConnectionsByProject, upsertConnection, setConnectionStatus,
} from '../lib/composio-store';

const projectIds: string[] = [];
const toolkitSlugs: string[] = [];
const tag = () => `vt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

afterEach(async () => {
  if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds)); // cascades connections
  if (toolkitSlugs.length) await db.delete(composioToolkits).where(inArray(composioToolkits.slug, toolkitSlugs));
  projectIds.length = 0;
  toolkitSlugs.length = 0;
});

async function freshProject() {
  const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
  projectIds.push(p.id);
  return p;
}

describe('composio store', () => {
  it('upserts the toolkit cache row (provided fields only)', async () => {
    const slug = `vt-${tag()}`;
    toolkitSlugs.push(slug);
    await upsertToolkitRow(slug, { authConfigId: 'ac_1' });
    await upsertToolkitRow(slug, { mcpServerId: 'srv_1', mcpUrl: 'https://x/v3/mcp/srv_1' });
    const row = await getToolkitRow(slug);
    expect(row?.authConfigId).toBe('ac_1');
    expect(row?.mcpServerId).toBe('srv_1');
    expect(row?.mcpUrl).toBe('https://x/v3/mcp/srv_1');
  });

  it('upserts a connection and enforces one row per (project, toolkit)', async () => {
    const p = await freshProject();
    const a = await upsertConnection(p.id, 'linear', { userId: `mc-proj-${p.id}`, status: 'initializing', connectedAccountId: 'ca_1' });
    const b = await upsertConnection(p.id, 'linear', { userId: `mc-proj-${p.id}`, status: 'active', connectedAccountId: 'ca_1' });
    expect(b.id).toBe(a.id); // same row (upsert, not a second insert)
    const list = await listConnectionsByProject(p.id);
    expect(list.length).toBe(1);
    expect(list[0].status).toBe('active');
  });

  it('setConnectionStatus updates status + error', async () => {
    const p = await freshProject();
    const c = await upsertConnection(p.id, 'slack', { userId: `mc-proj-${p.id}`, connectedAccountId: 'ca_2' });
    const updated = await setConnectionStatus(c.id, 'error', 'boom');
    expect(updated?.status).toBe('error');
    expect(updated?.error).toBe('boom');
  });

  it('upsertConnection preserves fields omitted from a conflict update', async () => {
    const p = await freshProject();
    await upsertConnection(p.id, 'linear', { userId: `mc-proj-${p.id}`, status: 'initializing', connectedAccountId: 'ca_x', linkUrl: 'https://connect/x' });
    // second upsert flips only status — connectedAccountId + linkUrl must remain
    await upsertConnection(p.id, 'linear', { userId: `mc-proj-${p.id}`, status: 'active' });
    const row = await getConnection(p.id, 'linear');
    expect(row?.status).toBe('active');
    expect(row?.connectedAccountId).toBe('ca_x');
    expect(row?.linkUrl).toBe('https://connect/x');
  });

  it('getConnection returns null when absent', async () => {
    const p = await freshProject();
    expect(await getConnection(p.id, 'linear')).toBeNull();
  });
});

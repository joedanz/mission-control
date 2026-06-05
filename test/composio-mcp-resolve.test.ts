// ABOUTME: resolveProjectMcpServers against real Neon — active connections join the toolkit mcpUrl;
// ABOUTME: non-active rows are excluded. Self-cleaning throwaway rows (uses random toolkit slugs so it
// ABOUTME: never mutates the real linear/slack cache rows in the shared DB).

import { describe, it, expect, afterEach } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, composioToolkits } from '../lib/db/schema';
import { createProject } from '../lib/mutations';
import { upsertToolkitRow, upsertConnection, upsertRemoteConnection } from '../lib/composio-store';
import { resolveProjectMcpServers } from '../lib/composio-connections';

const projectIds: string[] = [];
const toolkitSlugs: string[] = [];
const tag = () => `vt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

afterEach(async () => {
  if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds)); // cascades connections
  if (toolkitSlugs.length) await db.delete(composioToolkits).where(inArray(composioToolkits.slug, toolkitSlugs));
  projectIds.length = 0;
  toolkitSlugs.length = 0;
});

describe('resolveProjectMcpServers (real Neon)', () => {
  it('maps only ACTIVE connections, joining the toolkit mcpUrl', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    const lin = tag();
    const sla = tag();
    toolkitSlugs.push(lin, sla);
    await upsertToolkitRow(lin, { mcpUrl: `https://x/v3/mcp/${lin}` });
    await upsertToolkitRow(sla, { mcpUrl: `https://x/v3/mcp/${sla}` });
    await upsertConnection(p.id, lin, { userId: `mc-proj-${p.id}`, status: 'active', connectedAccountId: 'ca_1' });
    await upsertConnection(p.id, sla, { userId: `mc-proj-${p.id}`, status: 'initializing', connectedAccountId: 'ca_2' });

    const map = await resolveProjectMcpServers(p.slug);

    expect(Object.keys(map)).toEqual([`composio-${lin}`]); // the initializing one is excluded
    expect(map[`composio-${lin}`].url).toBe(`https://x/v3/mcp/${lin}?user_id=mc-proj-${p.id}`);
    expect(map[`composio-${lin}`].headers?.['x-api-key']).toBe('${COMPOSIO_API_KEY}');
  });

  it('skips an active connection whose toolkit cache row has no mcpUrl', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    const lin = tag();
    toolkitSlugs.push(lin);
    await upsertToolkitRow(lin, { authConfigId: 'ac_x' }); // cache row exists but no mcpUrl yet
    await upsertConnection(p.id, lin, { userId: `mc-proj-${p.id}`, status: 'active', connectedAccountId: 'ca_1' });

    expect(await resolveProjectMcpServers(p.slug)).toEqual({});
  });

  it('returns an empty map for a project with no active connections', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    expect(await resolveProjectMcpServers(p.slug)).toEqual({});
  });

  it('emits a remote-source connection as a direct http entry (headers preserved)', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    await upsertRemoteConnection(p.id, {
      remoteName: 'docs', remoteUrl: 'https://mcp.example.com/sse', remoteHeaders: { Authorization: 'Bearer ${DOCS_TOKEN}' },
    });
    const map = await resolveProjectMcpServers(p.slug);
    expect(map.docs).toEqual({ type: 'http', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } });
  });

  it('unions composio + remote sources in one map', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    const lin = tag();
    toolkitSlugs.push(lin);
    await upsertToolkitRow(lin, { mcpUrl: `https://x/v3/mcp/${lin}` });
    await upsertConnection(p.id, lin, { userId: `mc-proj-${p.id}`, status: 'active', connectedAccountId: 'ca_1' });
    await upsertRemoteConnection(p.id, { remoteName: 'docs', remoteUrl: 'https://r/sse', remoteHeaders: {} });

    const map = await resolveProjectMcpServers(p.slug);
    expect(Object.keys(map).sort()).toEqual([`composio-${lin}`, 'docs']);
    expect(map[`composio-${lin}`].url).toBe(`https://x/v3/mcp/${lin}?user_id=mc-proj-${p.id}`);
    expect(map.docs).toEqual({ type: 'http', url: 'https://r/sse' });
  });
});

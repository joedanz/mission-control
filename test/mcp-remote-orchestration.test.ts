// ABOUTME: addRemote / removeRemote orchestration against real Neon — validates input, persists, removes.

import { describe, it, expect, afterEach } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects } from '../lib/db/schema';
import { createProject } from '../lib/mutations';
import { addRemote, removeRemote } from '../lib/composio-connections';
import { ValidationError, NotFoundError } from '../lib/validation';

const projectIds: string[] = [];
const tag = () => `vt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

afterEach(async () => {
  if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
  projectIds.length = 0;
});

describe('addRemote / removeRemote (real Neon)', () => {
  it('addRemote validates + persists; removeRemote deletes', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    const c = await addRemote(p.slug, { name: 'docs', url: 'https://r/sse', headers: { Authorization: 'Bearer ${T}' } });
    expect(c.source).toBe('remote');
    expect(c.status).toBe('active');
    const removed = await removeRemote(p.slug, 'docs');
    expect(removed.remoteName).toBe('docs');
  });

  it('addRemote rejects a literal-secret header', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    await expect(addRemote(p.slug, { name: 'docs', url: 'https://r', headers: { Authorization: 'sk-raw' } })).rejects.toBeInstanceOf(ValidationError);
  });

  it('removeRemote throws NotFoundError for an unknown name', async () => {
    const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
    projectIds.push(p.id);
    await expect(removeRemote(p.slug, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

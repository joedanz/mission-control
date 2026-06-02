// ABOUTME: Verifies the projects.sentryProjectSlug column persists via createProject/updateProject.

import { describe, it, expect, afterAll } from 'vitest';
import { createProject, updateProject, deleteProject } from '../lib/mutations';
import { getProjectBySlug } from '../lib/queries';

const created: string[] = [];
afterAll(async () => { for (const id of created) await deleteProject(id); });

describe('projects.sentryProjectSlug', () => {
  it('persists through create + update + clear', async () => {
    const p = await createProject({
      name: `Sentry Field Test ${Date.now()}`,
      category: 'internal',
      status: 'prelaunch',
      sentryProjectSlug: 'my-sentry-proj',
    });
    created.push(p.id);
    expect((await getProjectBySlug(p.slug))?.sentryProjectSlug).toBe('my-sentry-proj');

    await updateProject(p.id, { sentryProjectSlug: 'renamed-proj' });
    expect((await getProjectBySlug(p.slug))?.sentryProjectSlug).toBe('renamed-proj');

    await updateProject(p.id, { sentryProjectSlug: null });
    expect((await getProjectBySlug(p.slug))?.sentryProjectSlug).toBeNull();
  });
});

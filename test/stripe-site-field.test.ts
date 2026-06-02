// ABOUTME: Verifies the projects.stripeSite column persists through createProject/updateProject.

import { describe, it, expect, afterAll } from 'vitest';
import { createProject, updateProject, deleteProject } from '../lib/mutations';
import { getProjectBySlug } from '../lib/queries';

const created: string[] = [];
afterAll(async () => { for (const id of created) await deleteProject(id); });

describe('projects.stripeSite', () => {
  it('persists on create and is readable via getProjectBySlug', async () => {
    const p = await createProject({
      name: `Stripe Site Test ${Date.now()}`,
      category: 'internal',
      status: 'prelaunch',
      stripeSite: 'memoiries',
    });
    created.push(p.id);
    expect(p.stripeSite).toBe('memoiries');
    const fetched = await getProjectBySlug(p.slug);
    expect(fetched?.stripeSite).toBe('memoiries');
  });

  it('updates and clears to null', async () => {
    const p = await createProject({
      name: `Stripe Site Test2 ${Date.now()}`,
      category: 'internal',
      status: 'prelaunch',
    });
    created.push(p.id);
    expect(p.stripeSite).toBeNull();
    const updated = await updateProject(p.id, { stripeSite: 'ticc' });
    expect(updated?.stripeSite).toBe('ticc');
    const cleared = await updateProject(p.id, { stripeSite: null });
    expect(cleared?.stripeSite).toBeNull();
  });
});

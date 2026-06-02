// ABOUTME: Verifies projects.emailProvider/emailAddress persist via createProject/updateProject.

import { describe, it, expect, afterAll } from 'vitest';
import { createProject, updateProject, deleteProject } from '../lib/mutations';
import { getProjectBySlug } from '../lib/queries';

const created: string[] = [];
afterAll(async () => { for (const id of created) await deleteProject(id); });

describe('projects email columns', () => {
  it('persist through create + update + clear', async () => {
    const p = await createProject({
      name: `Email Field Test ${Date.now()}`,
      category: 'internal',
      status: 'prelaunch',
      emailProvider: 'Google Workspace',
      emailAddress: 'hello@example.com',
    });
    created.push(p.id);
    const a = await getProjectBySlug(p.slug);
    expect(a?.emailProvider).toBe('Google Workspace');
    expect(a?.emailAddress).toBe('hello@example.com');

    await updateProject(p.id, { emailProvider: 'Zoho Mail' });
    expect((await getProjectBySlug(p.slug))?.emailProvider).toBe('Zoho Mail');

    await updateProject(p.id, { emailProvider: null, emailAddress: null });
    const c = await getProjectBySlug(p.slug);
    expect(c?.emailProvider).toBeNull();
    expect(c?.emailAddress).toBeNull();
  });
});

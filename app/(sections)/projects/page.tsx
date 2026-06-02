// ABOUTME: Projects section (Server Component) — the main work surface: the unified projects table
// ABOUTME: with category filter + inline search (Board), a "New" action, and a zero-state.

import { redirect } from 'next/navigation';
import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getProjectsWithTasks, type SearchItem } from '@/lib/queries';
import { ProjectTable } from '@/components/ProjectTable';
import { NewProjectButton } from '@/components/NewProjectButton';
import { Board } from '@/components/Board';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  try {
    await requireAllowedUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect('/login');
    throw e;
  }

  const all = await getProjectsWithTasks();
  const searchIndex: SearchItem[] = all.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    category: p.category,
    status: p.status,
    domain: p.domain,
  }));

  return (
    <>
      <div className="section-head">
        <h1 className="section-title">Projects</h1>
        {all.length > 0 && <NewProjectButton />}
      </div>

      {all.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">No projects yet</p>
          <p className="empty-state-hint">Create your first project to get started.</p>
          <div className="empty-state-action"><NewProjectButton /></div>
        </div>
      ) : (
        <Board index={searchIndex}>
          <ProjectTable projects={all} />
        </Board>
      )}
    </>
  );
}

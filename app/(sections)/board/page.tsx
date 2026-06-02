// ABOUTME: Overall Kanban board — all active projects as swimlanes. Auth-gated like every section
// ABOUTME: (defense in depth alongside the layout); seeds the client board from a server fetch.

import { redirect } from 'next/navigation';
import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getProjectsWithTasks } from '@/lib/queries';
import { toBoardProject } from '@/lib/board';
import { OverallBoard } from '@/components/board/OverallBoard';

export const dynamic = 'force-dynamic';

export default async function BoardPage() {
  try {
    await requireAllowedUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect('/login');
    throw e;
  }

  const all = await getProjectsWithTasks({ archived: 'active' });
  const initial = { projects: all.map((p) => toBoardProject(p, true)), runs: [] };

  return (
    <>
      <div className="section-head">
        <h1 className="section-title">Board</h1>
      </div>
      <OverallBoard initial={initial} />
    </>
  );
}

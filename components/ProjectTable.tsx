// ABOUTME: The unified project table (Server Component) — one sticky column header + every project
// ABOUTME: row in a single bordered panel. Tab + text filtering happens client-side in <Board> by
// ABOUTME: toggling row visibility via data-category / data-search, so this stays a flat server list.

import type { ProjectWithTasks } from '@/lib/queries';
import { ProjectRow } from './ProjectRow';

export function ProjectTable({ projects }: { projects: ProjectWithTasks[] }) {
  return (
    <div className="ptable" role="table" aria-label="Projects">
      <div className="col-head" role="row" aria-hidden="true">
        <span />
        <span>Project</span>
        <span>Type</span>
        <span>Stack</span>
        <span>Sentry</span>
        <span>Zoho</span>
        <span>Status</span>
        <span>Tasks</span>
        <span>Updated</span>
        <span />
      </div>
      <div className="ptable-body">
        {projects.map((p) => (
          <ProjectRow key={p.id} project={p} />
        ))}
      </div>
    </div>
  );
}

// ABOUTME: Overview "Recently active" list (Server Component) — the most recently touched projects,
// ABOUTME: derived from projects.lastActivityAt. Links into each project's detail page.

import Link from 'next/link';
import type { ProjectWithTasks } from '@/lib/queries';
import { statusTone, statusLabel, relativeTime } from '@/lib/ui';

export function RecentActivity({ projects }: { projects: ProjectWithTasks[] }) {
  return (
    <section className="recent" aria-label="Recently active projects">
      {projects.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">No activity yet</p>
          <p className="empty-state-hint">Project activity will show up here.</p>
        </div>
      ) : (
        <ul className="recent-list">
          {projects.map((p) => {
            const tone = statusTone(p.status);
            return (
              <li key={p.id} className="recent-item">
                <Link href={`/p/${p.slug}`} className="recent-link">
                  <span className={`row-tick ${tone}`} aria-hidden="true" />
                  <span className="recent-name">{p.name}</span>
                  <span className={`pill ${tone}`}>{statusLabel(p.status)}</span>
                  <span className="recent-time">{relativeTime(p.lastActivityAt)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ABOUTME: One project row (Server Component) — a native <details> table row that aligns into
// ABOUTME: fixed column lanes on wide screens and stacks to two lines on mobile. ONE layout.

import type { ProjectWithTasks } from '@/lib/queries';
import {
  statusTone,
  statusLabel,
  isTaskDone,
  incompleteCount,
  integrationStatusOf,
  categoryShort,
  categoryLabel,
  categoryTone,
  relativeTime,
} from '@/lib/ui';
import { Chevron } from './Chevron';
import { TaskItem } from './TaskItem';
import { AddTask } from './AddTask';
import { ProjectCardActions } from './ProjectCardActions';
import { RowNameLink } from './RowNameLink';

const STATE_WORD: Record<string, string> = { done: 'done', pending: 'pend', needed: 'need' };

function ExternalIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M7 17L17 7M17 7H9M17 7v8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IntgCell({
  lane,
  label,
  state,
}: {
  lane: string;
  label: string;
  state: 'done' | 'pending' | 'needed' | null;
}) {
  if (!state) {
    return (
      <span className={`col-intg ${lane} none`} title={`${label}: not tracked`}>
        <span className="lbl">{label} </span>—
      </span>
    );
  }
  return (
    <span className={`col-intg ${lane} ${state}`} title={`${label}: ${state}`}>
      <span className="intg-dot" aria-hidden="true" />
      <span className="lbl">{label} </span>
      {STATE_WORD[state]}
    </span>
  );
}

export function ProjectRow({ project }: { project: ProjectWithTasks }) {
  const tone = statusTone(project.status);
  const remaining = incompleteCount(project);
  const stack = project.techStack.slice(0, 3);
  const extra = project.techStack.length - stack.length;

  const searchText = `${project.name} ${project.domain ?? ''} ${project.slug}`.toLowerCase();
  const updated = relativeTime(project.lastActivityAt);

  return (
    <details className="row" data-search={searchText} data-category={project.category}>
      <summary className="row-head">
        <span className={`row-tick ${tone}`} aria-hidden="true" />

        <span className="col-name">
          <RowNameLink slug={project.slug} name={project.name} />
          {project.domain && <span className="row-domain">{project.domain}</span>}
        </span>

        <span className="col-type">
          <span
            className={`cat-chip ${categoryTone(project.category)}`}
            title={categoryLabel(project.category)}
          >
            {categoryShort(project.category)}
          </span>
        </span>

        <span className="col-stack">
          {stack.map((t) => (
            <span key={t} className="tag-sm">{t}</span>
          ))}
          {extra > 0 && <span className="tag-more">+{extra}</span>}
        </span>

        <IntgCell lane="sen" label="SEN" state={integrationStatusOf(project, 'sentry')} />
        <IntgCell lane="zoh" label="ZOH" state={integrationStatusOf(project, 'zoho_email')} />

        <span className={`pill ${tone}`}>{statusLabel(project.status)}</span>

        <span
          className={`row-count ${remaining === 0 ? 'clear' : ''}`}
          aria-label={remaining === 0 ? 'all tasks done' : `${remaining} open tasks`}
        >
          {remaining === 0 ? '✓' : remaining}
        </span>

        <span className="col-updated" title={`Last activity ${new Date(project.lastActivityAt).toLocaleString()}`}>
          {updated}
        </span>

        <Chevron className="row-chevron" />
      </summary>

      <div className="row-body">
        {project.techStack.length > 0 && (
          <div className="row-tags">
            {project.techStack.map((t) => (
              <span key={t} className="tag">{t}</span>
            ))}
          </div>
        )}

        {(project.repoUrl || project.liveUrl || project.repoPath) && (
          <div className="row-links">
            {project.liveUrl && (
              <a className="row-link" href={project.liveUrl} target="_blank" rel="noreferrer">
                <ExternalIcon /> live
              </a>
            )}
            {project.repoUrl && (
              <a className="row-link" href={project.repoUrl} target="_blank" rel="noreferrer">
                <ExternalIcon /> repo
              </a>
            )}
            {project.repoPath && <span className="row-link" title="local path">{project.repoPath}</span>}
          </div>
        )}

        {project.tasks.length > 0 && (
          <ul className="tasklist">
            {project.tasks.map((t) => (
              <TaskItem key={t.id} id={t.id} label={t.label} notes={t.notes} done={isTaskDone(t)} />
            ))}
          </ul>
        )}

        <AddTask projectId={project.id} />

        <div className="row-foot">
          <ProjectCardActions project={project} />
        </div>
      </div>
    </details>
  );
}

// ABOUTME: Project detail page (Server Component). Auth-gated, dynamic; tabs for overview/tasks/integrations/activity.

import { redirect, notFound } from 'next/navigation';
import { Suspense } from 'react';
import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getProjectBySlug, getSearchIndex } from '@/lib/queries';
import { statusTone, statusLabel, isTaskDone } from '@/lib/ui';
import { TopBar } from '@/components/chrome/TopBar';
import { TabbedPanels } from '@/components/TabbedPanels';
import { TaskItem } from '@/components/TaskItem';
import { AddTask } from '@/components/AddTask';
import { ProjectCardActions } from '@/components/ProjectCardActions';
import { ActivityFeed } from '@/components/ActivityFeed';
import { ProjectBoard } from '@/components/board/ProjectBoard';
import { toBoardProject } from '@/lib/board';
import { parseGitHubRepo } from '@/lib/github';
import { CommitsTab } from '@/components/CommitsTab';
import { PullsTab } from '@/components/PullsTab';
import { ErrorsTab } from '@/components/ErrorsTab';
import { EmailTab } from '@/components/EmailTab';
import { RevenueTab } from '@/components/RevenueTab';
import { IntegrationsTab } from '@/components/IntegrationsTab';

export const dynamic = 'force-dynamic';

const CATEGORY_LABEL: Record<string, string> = {
  internal: 'Internal Products',
  open_source: 'Open Source',
  client: 'Client Projects',
};

function fmtDate(d: Date | string | null): string {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M7 17L17 7M17 7H9M17 7v8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="detail-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default async function ProjectDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  let email = '';
  try {
    const session = await requireAllowedUser();
    email = session.user.email;
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect('/login');
    throw e;
  }

  const { slug } = await params;
  const [project, index] = await Promise.all([getProjectBySlug(slug), getSearchIndex()]);
  if (!project) notFound();

  const tone = statusTone(project.status);
  const integrationTasks = project.tasks.filter((t) => t.integrationType);
  const customTasks = project.tasks.filter((t) => !t.integrationType);
  const githubRepo = parseGitHubRepo(project.repoUrl);

  const overview = (
    <dl className="detail-fields">
      <Field label="Status">{statusLabel(project.status)}</Field>
      <Field label="Category">{CATEGORY_LABEL[project.category] ?? project.category}</Field>
      <Field label="Priority">{project.priority ?? '—'}</Field>
      <Field label="Domain">
        {project.domain ? (
          <a className="detail-link" href={`https://${project.domain}`} target="_blank" rel="noreferrer">
            {project.domain} <ExternalIcon />
          </a>
        ) : '—'}
      </Field>
      <Field label="Live">
        {project.liveUrl ? (
          <a className="detail-link" href={project.liveUrl} target="_blank" rel="noreferrer">
            {project.liveUrl} <ExternalIcon />
          </a>
        ) : '—'}
      </Field>
      <Field label="Repo">
        {project.repoUrl ? (
          <a className="detail-link" href={project.repoUrl} target="_blank" rel="noreferrer">
            {project.repoUrl} <ExternalIcon />
          </a>
        ) : '—'}
      </Field>
      <Field label="Local path">{project.repoPath ? <code className="detail-path">{project.repoPath}</code> : '—'}</Field>
      <Field label="Stack">
        {project.techStack.length > 0 ? (
          <span className="detail-tags">
            {project.techStack.map((t) => <span key={t} className="tag-sm">{t}</span>)}
          </span>
        ) : '—'}
      </Field>
      {project.description && <Field label="Description">{project.description}</Field>}
      {project.notes && <Field label="Notes">{project.notes}</Field>}
    </dl>
  );

  const tasksPanel = (
    <div className="detail-tasks">
      {customTasks.length > 0 ? (
        <ul className="tasklist">
          {customTasks.map((t) => (
            <TaskItem key={t.id} id={t.id} label={t.label} notes={t.notes} done={isTaskDone(t)} />
          ))}
        </ul>
      ) : (
        <p className="detail-muted">No tasks yet.</p>
      )}
      <AddTask projectId={project.id} />
    </div>
  );

  const integrationsPanel = <IntegrationsTab slug={project.slug} />;

  const boardInitial = { projects: [toBoardProject(project, false)], runs: [] };
  const boardIntegrations = {
    done: integrationTasks.filter((t) => t.integrationStatus === 'done').length,
    total: integrationTasks.length,
  };
  const boardPanel = (
    <ProjectBoard slug={project.slug} initial={boardInitial} integrations={boardIntegrations} />
  );

  const activityPanel = (
    <div className="detail-activity">
      <dl className="detail-fields">
        <Field label="Created">{fmtDate(project.createdAt)}</Field>
        <Field label="Updated">{fmtDate(project.updatedAt)}</Field>
        <Field label="Last activity">{fmtDate(project.lastActivityAt)}</Field>
        <Field label="Target date">{fmtDate(project.targetDate)}</Field>
      </dl>
      <ActivityFeed projectId={project.id} showRuns={false} />
    </div>
  );

  return (
    <>
      <TopBar index={index} email={email} />
      <main className="content-shell">
        <header className="detail-head">
          <div className="detail-title">
            <span className={`row-tick ${tone}`} aria-hidden="true" />
            <h1>{project.name}</h1>
            <span className={`pill ${tone}`}>{statusLabel(project.status)}</span>
          </div>
          <div className="detail-actions">
            <ProjectCardActions project={project} />
          </div>
        </header>

        <Suspense
          fallback={
            <div className="skeleton" aria-hidden="true">
              <div className="skeleton-bar tall" />
              <div className="skeleton-bar" />
              <div className="skeleton-bar" />
            </div>
          }
        >
          <TabbedPanels
            tabs={[
              { key: 'overview', label: 'Overview', content: overview },
              { key: 'tasks', label: 'Tasks', content: tasksPanel },
              { key: 'board', label: 'Board', content: boardPanel },
              { key: 'integrations', label: 'Integrations', content: integrationsPanel },
              { key: 'activity', label: 'Activity', content: activityPanel },
              ...(githubRepo ? [
                { key: 'commits', label: 'Commits', content: <CommitsTab slug={project.slug} /> },
                { key: 'prs', label: 'PRs', content: <PullsTab slug={project.slug} /> },
              ] : []),
              ...(project.domain ? [
                { key: 'email', label: 'Email', content: <EmailTab slug={project.slug} /> },
              ] : []),
              ...(project.sentryProjectSlug ? [
                { key: 'errors', label: 'Errors', content: <ErrorsTab slug={project.slug} /> },
              ] : []),
              ...(project.stripeSite ? [
                { key: 'revenue', label: 'Revenue', content: <RevenueTab slug={project.slug} /> },
              ] : []),
            ]}
          />
        </Suspense>
      </main>
    </>
  );
}

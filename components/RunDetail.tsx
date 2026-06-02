'use client';

// ABOUTME: Run drill-in surface — metadata fields (tokens/cost/model/timing) + the run's event
// ABOUTME: timeline, polling /api/runs/[id] via useRunDetail. Reuses the detail-* + mc-feed styles.

import { useTransition } from 'react';
import { relativeTime, formatCost, runTone, formatShortDateTime } from '@/lib/ui';
import { useRunDetail } from '@/lib/useRunDetail';
import { requestRunCancel } from '@/app/actions';
import { EventList } from '@/components/EventList';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="detail-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function RunDetail({ id }: { id: string }) {
  const { run, loaded, notFound, error, reload } = useRunDetail(id);
  const [cancelling, startCancel] = useTransition();

  if (!loaded) {
    return (
      <div className="skeleton" aria-hidden="true">
        <div className="skeleton-bar tall" />
        <div className="skeleton-bar" />
        <div className="skeleton-bar" />
      </div>
    );
  }

  if (notFound || !run) {
    return <p className="detail-muted">Run not found{error ? ` · ${error}` : ''}.</p>;
  }

  const tone = runTone(run);

  return (
    <div className="mc">
      <header className="detail-head" data-tone={tone}>
        <div className="detail-title">
          <span className={`sig-dot${run.live ? ' pulse-dot' : ''}`} aria-hidden="true" />
          <h1>{run.agentLabel}</h1>
          <span className="mc-run-status">{run.live ? 'live' : run.status}</span>
        </div>
        <div className="detail-actions">
          <span className="mc-run-meta">
            {relativeTime(run.lastHeartbeatAt)}
            {error ? <span className="mc-err"> · {error}</span> : null}
          </span>
          {run.cancelRequested && (
            <span className="pill warn" aria-live="polite">
              Cancel requested
            </span>
          )}
          {run.live && run.status === 'running' && (
            <button
              type="button"
              className="btn btn-danger"
              disabled={cancelling || run.cancelRequested}
              title="Request cancellation — halts the run's next tool call if its machine has the kill-switch hook wired"
              // revalidatePath only refreshes server components; this view is client-polled, so reload()
              // after the write surfaces the badge/terminal-status immediately instead of waiting ≤4s.
              onClick={() => startCancel(async () => { await requestRunCancel(id); reload(); })}
            >
              {cancelling ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </div>
      </header>

      <dl className="detail-fields">
        {run.title && <Field label="Title">{run.title}</Field>}
        <Field label="Source">{run.source}</Field>
        {run.model && <Field label="Model">{run.model}</Field>}
        <Field label="Project">
          {run.project ? <a className="detail-link" href={`/p/${run.project.slug}`}>{run.project.name}</a> : '—'}
        </Field>
        {run.claimedTask && <Field label="Claimed task">▸ {run.claimedTask.label}</Field>}
        <Field label="Tokens">
          {run.tokensIn.toLocaleString()} in · {run.tokensOut.toLocaleString()} out
        </Field>
        <Field label="Cache">
          {run.cacheReadTokens.toLocaleString()} read · {run.cacheWriteTokens.toLocaleString()} write
        </Field>
        <Field label="Cost">{formatCost(run.costMicros) || '—'}</Field>
        <Field label="Started">{formatShortDateTime(run.startedAt)}</Field>
        <Field label="Last heartbeat">{formatShortDateTime(run.lastHeartbeatAt)}</Field>
        {run.endedAt && <Field label="Ended">{formatShortDateTime(run.endedAt)}</Field>}
        {run.sessionId && <Field label="Session">{run.sessionId}</Field>}
        {run.workDir && (
          <Field label="Work dir">
            <code className="detail-path">{run.workDir}</code>
          </Field>
        )}
      </dl>

      <section className="mc-feed-wrap" aria-label="Run events">
        <h2 className="section-sublabel">
          Events <span className="mc-count">{run.eventsTruncated ? `latest ${run.events.length}` : run.events.length}</span>
        </h2>
        {run.events.length === 0 ? (
          <p className="mc-empty">No events for this run.</p>
        ) : (
          <EventList events={run.events} />
        )}
      </section>
    </div>
  );
}

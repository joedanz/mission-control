'use client';

// ABOUTME: Workflows tab — a left rail of the project's workflows + the read-only @xyflow/react canvas for the
// ABOUTME: selected one, with its live per-node step overlay (polled). The "Run" button POSTs to enqueue a run
// ABOUTME: (status 'queued') that the workflow-daemon executes (slice 4); the poll reflects queued→running→done.
// ABOUTME: A run already queued/in progress disables Run (single-flight → 409). List fetch mirrors IntegrationsTab.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowListItem, WorkflowRunSummary } from '@/lib/workflow-view';
import { useWorkflowRun } from '@/lib/useWorkflowRun';
import { WorkflowCanvas } from './WorkflowCanvas';

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; workflows: WorkflowListItem[] };

const RUN_TONE: Record<WorkflowRunSummary['status'], string> = {
  queued: 'info', running: 'info', completed: 'ok', failed: 'bad', cancelled: 'warn',
};

function RunBadge({ run }: { run: WorkflowRunSummary | null }) {
  if (!run) return <span className="wf-runbadge wf-runbadge--idle">no runs</span>;
  return <span className={`wf-runbadge wf-runbadge--${RUN_TONE[run.status]}`}>{run.status}</span>;
}

export function WorkflowsTab({ slug }: { slug: string }) {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const loadSeq = useRef(0);

  // Map a list response → state. Shared by the retry path (loadList) and the inlined mount fetch.
  const applyList = useCallback((json: { ok: boolean; error?: string; data?: { workflows: WorkflowListItem[] } }) => {
    if (json.ok && json.data) {
      const workflows = json.data.workflows;
      setState({ kind: 'data', workflows });
      setSelected((cur) => cur ?? workflows[0]?.slug ?? null); // default to the first workflow
    } else {
      setState({ kind: 'error', message: json.error ?? 'Failed to load workflows' });
    }
  }, []);

  const loadList = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await fetch(`/api/projects/${slug}/workflows`, { cache: 'no-store' });
      const json = await res.json();
      if (seq === loadSeq.current) applyList(json);
    } catch (err) {
      if (seq === loadSeq.current) setState({ kind: 'error', message: String(err) });
    }
  }, [slug, applyList]);

  // Initial fetch inlined with .then (rather than calling loadList) so setState is deferred into the
  // promise callback — keeps react-hooks/set-state-in-effect satisfied (same idiom as IntegrationsTab).
  useEffect(() => {
    const seq = ++loadSeq.current;
    fetch(`/api/projects/${slug}/workflows`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((json) => { if (seq === loadSeq.current) applyList(json); })
      .catch((err: unknown) => { if (seq === loadSeq.current) setState({ kind: 'error', message: String(err) }); });
  }, [slug, applyList]);

  const { detail, loaded, error } = useWorkflowRun({ projectSlug: slug, workflowSlug: selected });

  const [triggering, setTriggering] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  // A run is active when its latest run hasn't reached a terminal status. The poll updates this within ~4s of
  // the enqueue; until then `triggering` + the server-side single-flight guard (409) prevent a double-run.
  const latestStatus = detail?.latestRun?.status;
  const runActive = latestStatus === 'queued' || latestStatus === 'running';

  const onRun = useCallback(async () => {
    if (!selected) return;
    setTriggering(true);
    setRunMsg(null);
    try {
      const res = await fetch(`/api/projects/${slug}/workflows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflow: selected, action: 'run' }),
      });
      const json = await res.json();
      if (res.ok && json.ok) {
        setRunMsg('queued — the workflow-daemon will pick it up');
        void loadList(); // refresh the rail badges now; the detail badge updates on the next poll
      } else if (res.status === 409) {
        setRunMsg('a run is already queued or in progress');
      } else {
        setRunMsg(json.message ?? json.error ?? `failed (HTTP ${res.status})`);
      }
    } catch (e) {
      setRunMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setTriggering(false);
    }
  }, [slug, selected, loadList]);

  if (state.kind === 'loading') {
    return (
      <div className="wf-tab skeleton" aria-label="Loading workflows">
        <div className="skeleton-bar" />
        <div className="skeleton-bar tall" />
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="detail-workflows">
        <p className="detail-muted">Failed to load workflows: {state.message}</p>
        <button type="button" className="btn-sm" onClick={() => { setState({ kind: 'loading' }); void loadList(); }}>
          Retry
        </button>
      </div>
    );
  }

  if (state.workflows.length === 0) {
    return (
      <div className="detail-workflows">
        <p className="detail-muted">No workflows yet.</p>
        <p className="detail-muted">
          Create one with <code className="detail-path">mc workflow create --project {slug} --name &lt;name&gt;</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="wf-tab">
      <aside className="wf-rail" role="tablist" aria-label="Workflows">
        {state.workflows.map((wf) => (
          <button
            key={wf.slug}
            type="button"
            role="tab"
            aria-selected={wf.slug === selected}
            className={`wf-rail__item${wf.slug === selected ? ' active' : ''}`}
            onClick={() => setSelected(wf.slug)}
          >
            <span className="wf-rail__name">{wf.name}</span>
            <span className="wf-rail__meta">
              {wf.nodeCount} {wf.nodeCount === 1 ? 'node' : 'nodes'}
              <RunBadge run={wf.latestRun} />
            </span>
          </button>
        ))}
      </aside>

      <section className="wf-main">
        <header className="wf-main__head">
          <div className="wf-main__title">
            <h3>{detail?.name ?? '—'}</h3>
            <RunBadge run={detail?.latestRun ?? null} />
          </div>
          <div className="wf-main__run">
            <button
              type="button"
              className="btn-sm"
              disabled={!selected || triggering || runActive}
              title={runActive ? 'a run is already queued or in progress' : `Enqueue a run of ${selected ?? ''} (executed by the workflow-daemon)`}
              onClick={onRun}
            >
              {triggering ? 'Starting…' : runActive ? 'Running…' : 'Run ▸'}
            </button>
            {runMsg && <span className="wf-run-msg detail-muted">{runMsg}</span>}
          </div>
        </header>

        {!loaded && <div className="wf-canvas wf-canvas--placeholder">Loading graph…</div>}
        {loaded && error && <p className="detail-muted">Failed to load graph: {error}</p>}
        {loaded && !error && detail && (
          <WorkflowCanvas graph={detail.graph} stepStatus={detail.stepStatus} />
        )}
      </section>
    </div>
  );
}

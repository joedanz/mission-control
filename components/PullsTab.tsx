// ABOUTME: Client component for the PRs tab — fetches open + recently-merged PRs, lazy-loads detail on expand.

'use client';

import { useState, useEffect } from 'react';
import type { GitHubPR, GitHubPRDetail } from '@/lib/github-api';

type PullsState =
  | { kind: 'loading' }
  | { kind: 'no_repo' }
  | { kind: 'no_token' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; open: GitHubPR[]; recentlyMerged: GitHubPR[] };

type DetailState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; detail: GitHubPRDetail };

function fmtAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const REVIEW_PILL = {
  APPROVED: { className: 'pull-review-pill approved', label: 'Approved' },
  CHANGES_REQUESTED: { className: 'pull-review-pill changes', label: 'Changes Requested' },
} as const;

const CI_PILL = {
  success: { className: 'pull-ci-pill success', label: '✓ CI' },
  failure: { className: 'pull-ci-pill failure', label: '✗ CI' },
  pending: { className: 'pull-ci-pill pending', label: '⏳ CI' },
  neutral: { className: 'pull-ci-pill neutral', label: 'CI' },
} as const;

function PrRow({
  pr,
  slug,
  onClosed,
}: {
  pr: GitHubPR;
  slug: string;
  onClosed: (number: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DetailState>({ kind: 'idle' });

  async function handleExpand() {
    const next = !open;
    setOpen(next);
    if (next && detail.kind === 'idle') {
      setDetail({ kind: 'loading' });
      try {
        const res = await fetch(`/api/projects/${slug}/pulls/${pr.number}`);
        const json = (await res.json()) as { ok: boolean; data?: { pr: GitHubPRDetail } };
        setDetail(json.ok && json.data
          ? { kind: 'data', detail: json.data.pr }
          : { kind: 'error' });
      } catch {
        setDetail({ kind: 'error' });
      }
    }
  }

  const isOpen = pr.state === 'open';

  return (
    <li className="pull-row">
      <button
        className="pull-head"
        onClick={handleExpand}
        aria-expanded={open}
        type="button"
      >
        <span className="pull-number">#{pr.number}</span>
        <span className="pull-title-group">
          {pr.draft && <span className="pull-badge">Draft</span>}
          <span className="pull-title">{pr.title}</span>
        </span>
        <span className="pull-meta">
          {pr.labels.length > 0 && (
            <span className="pull-labels">
              {pr.labels.map((l) => <span key={l} className="pull-label-chip">{l}</span>)}
            </span>
          )}
          {pr.commentCount > 0 && <span>{pr.commentCount} 💬</span>}
          <span>{pr.author}</span>
          <span>{fmtAge(pr.updatedAt)}</span>
        </span>
        <a
          className="pull-gh-link"
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          aria-label="View on GitHub"
        >
          ↗
        </a>
      </button>

      {open && (
        <div className="pull-detail-body">
          {detail.kind === 'loading' && (
            <p className="pull-detail-loading">Loading details…</p>
          )}
          {detail.kind === 'error' && (
            <p className="pull-detail-error">Failed to load PR details.</p>
          )}
          {detail.kind === 'data' && (
            <>
              <div className="pull-meta-row">
                <span className="pull-branch">{detail.detail.headBranch} → {detail.detail.baseBranch}</span>
                <span>
                  <span className="diff-add-count">+{detail.detail.additions}</span>
                  {' '}
                  <span className="diff-del-count">−{detail.detail.deletions}</span>
                  {' '}
                  <span className="diff-total-count">across {detail.detail.changedFiles} files</span>
                </span>
                {detail.detail.reviewDecision !== null && (
                  <span className={REVIEW_PILL[detail.detail.reviewDecision].className}>
                    {REVIEW_PILL[detail.detail.reviewDecision].label}
                  </span>
                )}
                {detail.detail.ciStatus !== null && (
                  <span className={CI_PILL[detail.detail.ciStatus].className}>
                    {CI_PILL[detail.detail.ciStatus].label}
                  </span>
                )}
              </div>

              {detail.detail.reviews.length > 0 && (
                <div className="pull-reviewer-list">
                  {detail.detail.reviews
                    .filter((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')
                    .map((r) => (
                      <span key={r.id}>
                        {r.state === 'APPROVED' ? '✓' : '✗'} {r.author}
                        {r.body && ` — ${r.body.slice(0, 80)}${r.body.length > 80 ? '…' : ''}`}
                      </span>
                    ))}
                </div>
              )}

              {detail.detail.checkRuns.length > 0 && (
                <div className="pull-check-list">
                  {detail.detail.checkRuns.map((c, i) => (
                    <div key={i} className="pull-check-item">
                      <span>{c.conclusion === 'success' ? '✓' : c.status !== 'completed' ? '⏳' : '✗'}</span>
                      <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a>
                    </div>
                  ))}
                </div>
              )}

              {isOpen && !pr.draft && (
                <ActionPanel
                  pr={pr}
                  slug={slug}
                  detail={detail.detail}
                  setDetail={(s) => setDetail(s)}
                  onClosed={onClosed}
                />
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

type ActionState =
  | { kind: 'idle' }
  | { kind: 'confirm_close' }
  | { kind: 'request_changes_form' }
  | { kind: 'pending' }
  | { kind: 'error'; message: string };

function ActionPanel({
  pr,
  slug,
  detail,
  setDetail,
  onClosed,
}: {
  pr: GitHubPR;
  slug: string;
  detail: GitHubPRDetail;
  setDetail: (s: DetailState) => void;
  onClosed: (number: number) => void;
}) {
  const [action, setAction] = useState<ActionState>({ kind: 'idle' });
  const [rcBody, setRcBody] = useState('');

  async function handleApprove() {
    setAction({ kind: 'pending' });
    // Optimistic update
    setDetail({ kind: 'data', detail: { ...detail, reviewDecision: 'APPROVED' } });
    try {
      const res = await fetch(`/api/projects/${slug}/pulls/${pr.number}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve' }),
      });
      const json = (await res.json()) as { ok: boolean; message?: string };
      if (!json.ok) throw new Error(json.message ?? 'Failed');
      setAction({ kind: 'idle' });
    } catch (e) {
      setDetail({ kind: 'data', detail });
      setAction({ kind: 'error', message: String(e) });
    }
  }

  async function handleRequestChanges() {
    if (!rcBody.trim()) return;
    setAction({ kind: 'pending' });
    setDetail({ kind: 'data', detail: { ...detail, reviewDecision: 'CHANGES_REQUESTED' } });
    try {
      const res = await fetch(`/api/projects/${slug}/pulls/${pr.number}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request_changes', body: rcBody }),
      });
      const json = (await res.json()) as { ok: boolean; message?: string };
      if (!json.ok) throw new Error(json.message ?? 'Failed');
      setAction({ kind: 'idle' });
      setRcBody('');
    } catch (e) {
      setDetail({ kind: 'data', detail });
      setAction({ kind: 'error', message: String(e) });
    }
  }

  async function handleClose() {
    setAction({ kind: 'pending' });
    try {
      const res = await fetch(`/api/projects/${slug}/pulls/${pr.number}/close`, {
        method: 'POST',
      });
      const json = (await res.json()) as { ok: boolean; message?: string };
      if (!json.ok) throw new Error(json.message ?? 'Failed');
      onClosed(pr.number);
    } catch (e) {
      setAction({ kind: 'error', message: String(e) });
    }
  }

  const pending = action.kind === 'pending';

  return (
    <div className="pull-actions">
      {action.kind === 'error' && (
        <p className="pull-inline-error">{action.message}</p>
      )}

      {action.kind === 'request_changes_form' ? (
        <div className="pull-rc-form">
          <textarea
            className="pull-rc-textarea"
            value={rcBody}
            onChange={(e) => setRcBody(e.target.value)}
            placeholder="Describe the changes needed…"
            rows={3}
            autoFocus
          />
          <div className="pull-action-row">
            <button
              className="btn-sm btn-bad"
              onClick={handleRequestChanges}
              disabled={pending || !rcBody.trim()}
              type="button"
            >
              {pending ? 'Submitting…' : 'Submit'}
            </button>
            <button
              className="btn-sm btn-ghost"
              onClick={() => setAction({ kind: 'idle' })}
              disabled={pending}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : action.kind === 'confirm_close' ? (
        <div className="pull-action-row">
          <button
            className="btn-sm btn-bad"
            onClick={handleClose}
            disabled={pending}
            type="button"
          >
            {pending ? 'Closing…' : 'Confirm Close'}
          </button>
          <button
            className="btn-sm btn-ghost"
            onClick={() => setAction({ kind: 'idle' })}
            disabled={pending}
            type="button"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="pull-action-row">
          <button
            className="btn-sm btn-ok"
            onClick={handleApprove}
            disabled={pending}
            type="button"
          >
            Approve
          </button>
          <button
            className="btn-sm btn-warn"
            onClick={() => setAction({ kind: 'request_changes_form' })}
            disabled={pending}
            type="button"
          >
            Request Changes
          </button>
          <button
            className="btn-sm btn-ghost"
            onClick={() => setAction({ kind: 'confirm_close' })}
            disabled={pending}
            type="button"
          >
            Close PR
          </button>
        </div>
      )}
    </div>
  );
}

function PrList({ prs, slug, onClosed }: { prs: GitHubPR[]; slug: string; onClosed: (n: number) => void }) {
  return (
    <ul className="pulls-list">
      {prs.map((pr) => (
        <PrRow key={pr.number} pr={pr} slug={slug} onClosed={onClosed} />
      ))}
    </ul>
  );
}

export function PullsTab({ slug }: { slug: string }) {
  const [state, setState] = useState<PullsState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${slug}/pulls`)
      .then((r) => r.json())
      .then((json: { ok: boolean; error?: string; message?: string; data?: { open: GitHubPR[]; recentlyMerged: GitHubPR[] } }) => {
        if (cancelled) return;
        if (json.ok && json.data) {
          setState({ kind: 'data', open: json.data.open, recentlyMerged: json.data.recentlyMerged });
        } else if (json.error === 'no_github_repo') {
          setState({ kind: 'no_repo' });
        } else if (json.error === 'github_token_missing') {
          setState({ kind: 'no_token' });
        } else {
          setState({ kind: 'error', message: json.message ?? json.error ?? 'Unknown error' });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: String(err) });
      });
    return () => { cancelled = true; };
  }, [slug]);

  function handleClosed(prNumber: number) {
    setState((prev) => {
      if (prev.kind !== 'data') return prev;
      return { ...prev, open: prev.open.filter((p) => p.number !== prNumber) };
    });
  }

  if (state.kind === 'loading') {
    return (
      <div className="pulls-loading" aria-label="Loading pull requests">
        <div className="skeleton-bar" />
        <div className="skeleton-bar" />
        <div className="skeleton-bar" />
      </div>
    );
  }

  if (state.kind === 'no_repo') {
    return <p className="detail-muted">No GitHub repository configured for this project.</p>;
  }

  if (state.kind === 'no_token') {
    return (
      <div className="commits-setup">
        <p className="commits-setup-msg">
          Add <code>GITHUB_TOKEN</code> to your environment to view pull requests.
        </p>
        <p className="detail-muted">
          Create a fine-grained token with <strong>Pull requests: Read and Write</strong> at{' '}
          <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noreferrer">
            github.com/settings/tokens
          </a>.
        </p>
      </div>
    );
  }

  if (state.kind === 'error') {
    return <p className="pulls-error">Failed to load pull requests: {state.message}</p>;
  }

  const hasAny = state.open.length > 0 || state.recentlyMerged.length > 0;
  if (!hasAny) {
    return <p className="detail-muted">No open or recently merged pull requests.</p>;
  }

  return (
    <div className="pulls-panel">
      {state.open.length > 0 && (
        <div>
          <p className="pulls-section-label">Open</p>
          <PrList prs={state.open} slug={slug} onClosed={handleClosed} />
        </div>
      )}
      {state.recentlyMerged.length > 0 && (
        <div>
          <p className="pulls-section-label">Merged in last 7 days</p>
          <PrList prs={state.recentlyMerged} slug={slug} onClosed={handleClosed} />
        </div>
      )}
    </div>
  );
}

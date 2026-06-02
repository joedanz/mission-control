// ABOUTME: Client component for the Commits tab — fetches recent commits, lazy-loads diffs on expand.

'use client';

import { useState, useEffect } from 'react';
import type { GitHubCommit, GitHubCommitDetail, GitHubCommitFile } from '@/lib/github-api';

type CommitState =
  | { kind: 'loading' }
  | { kind: 'no_repo' }
  | { kind: 'no_token' }
  | { kind: 'error'; message: string }
  | { kind: 'data'; commits: GitHubCommit[] };

type DiffState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'data'; detail: GitHubCommitDetail };

function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function FileDiff({ file }: { file: GitHubCommitFile }) {
  const [open, setOpen] = useState(false);
  const STATUS_CLASS: Partial<Record<GitHubCommitFile['status'], string>> = {
    added: 'diff-status-chip added',
    removed: 'diff-status-chip removed',
    modified: 'diff-status-chip modified',
    renamed: 'diff-status-chip renamed',
  };
  const statusClass = STATUS_CLASS[file.status] ?? 'diff-status-chip';

  return (
    <div className="diff-file">
      <button
        className="diff-file-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        type="button"
      >
        <span className={statusClass}>{file.status.charAt(0).toUpperCase()}</span>
        <span className="diff-filename">{file.filename}</span>
        <span className="diff-file-stats">
          {file.additions > 0 && <span className="diff-add-count">+{file.additions}</span>}
          {file.deletions > 0 && <span className="diff-del-count">−{file.deletions}</span>}
        </span>
        <span className="diff-chevron" aria-hidden="true">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="diff-patch">
          {file.patch ? (
            file.patch.split('\n').map((line, i) => {
              const cls = line.startsWith('+') ? 'diff-line add'
                : line.startsWith('-') ? 'diff-line del'
                : line.startsWith('@') ? 'diff-line hunk'
                : 'diff-line ctx';
              return <div key={i} className={cls}><code>{line}</code></div>;
            })
          ) : (
            <p className="diff-no-patch">Binary or empty file — no patch available.</p>
          )}
        </div>
      )}
    </div>
  );
}

function CommitRow({ commit, slug }: { commit: GitHubCommit; slug: string }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<DiffState>({ kind: 'idle' });

  async function handleExpand() {
    const next = !open;
    setOpen(next);
    if (next && diff.kind === 'idle') {
      setDiff({ kind: 'loading' });
      try {
        const res = await fetch(`/api/projects/${slug}/commits/${commit.sha}`);
        const json = (await res.json()) as { ok: boolean; data?: { commit: GitHubCommitDetail } };
        setDiff(json.ok && json.data
          ? { kind: 'data', detail: json.data.commit }
          : { kind: 'error' });
      } catch {
        setDiff({ kind: 'error' });
      }
    }
  }

  return (
    <li className="commit-row">
      <button
        className="commit-head"
        onClick={handleExpand}
        aria-expanded={open}
        type="button"
      >
        <code className="commit-sha">{commit.shortSha}</code>
        <span className="commit-msg">{commit.message}</span>
        <span className="commit-meta">{commit.authorName} · {fmtDate(commit.authorDate)}</span>
        <a
          className="commit-gh-link"
          href={commit.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          aria-label="View on GitHub"
        >
          ↗
        </a>
      </button>
      {open && (
        <div className="commit-diff-body">
          {diff.kind === 'loading' && <p className="diff-loading">Loading diff…</p>}
          {diff.kind === 'error' && <p className="diff-error">Failed to load diff.</p>}
          {diff.kind === 'data' && (
            <>
              {commit.body && <p className="commit-body-text">{commit.body}</p>}
              <div className="diff-summary-bar">
                <span className="diff-add-count">+{diff.detail.stats.additions}</span>
                <span className="diff-del-count">−{diff.detail.stats.deletions}</span>
                <span className="diff-total-count">{diff.detail.stats.total} changed</span>
              </div>
              <div className="diff-files-list">
                {diff.detail.files.map((f) => (
                  <FileDiff key={f.filename} file={f} />
                ))}
                {diff.detail.files.length === 0 && (
                  <p className="diff-no-patch">No file changes recorded for this commit.</p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function CommitsTab({ slug }: { slug: string }) {
  const [state, setState] = useState<CommitState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${slug}/commits`)
      .then((r) => r.json())
      .then((json: { ok: boolean; error?: string; message?: string; data?: { commits: GitHubCommit[] } }) => {
        if (cancelled) return;
        if (json.ok && json.data) {
          setState({ kind: 'data', commits: json.data.commits });
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

  if (state.kind === 'loading') {
    return (
      <div className="commits-loading" aria-label="Loading commits">
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
          Add <code>GITHUB_TOKEN</code> to your environment to view commits.
        </p>
        <p className="detail-muted">
          Create a fine-grained token with <strong>Contents: Read</strong> at{' '}
          <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noreferrer">
            github.com/settings/tokens
          </a>.
        </p>
      </div>
    );
  }

  if (state.kind === 'error') {
    return <p className="commits-error">Failed to load commits: {state.message}</p>;
  }

  if (state.commits.length === 0) {
    return <p className="detail-muted">No commits found.</p>;
  }

  return (
    <div className="commits-panel">
      <ul className="commits-list">
        {state.commits.map((c) => (
          <CommitRow key={c.sha} commit={c} slug={slug} />
        ))}
      </ul>
    </div>
  );
}

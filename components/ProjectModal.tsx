'use client';

// ABOUTME: Create/edit project modal. Builds FormData and calls the create/update server actions.

import { useState, useTransition } from 'react';
import { createProject, updateProject } from '@/app/actions';
import type { Project } from '@/lib/db/schema';

const CATEGORIES = [
  ['internal', 'Internal Products'],
  ['open_source', 'Open Source'],
  ['client', 'Client Projects'],
] as const;
const STATUS_OPTS = ['prelaunch', 'launched', 'testing', 'active', 'design', 'planning'] as const;
const ACCENT_OPTS = ['orange', 'green', 'blue', 'violet', 'warm'] as const;
const PRIORITY_OPTS = ['', 'low', 'medium', 'high'] as const;

export function ProjectModal({ project, onClose }: { project?: Project; onClose: () => void }) {
  const isEdit = !!project;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      try {
        if (isEdit) await updateProject(project!.id, fd);
        else await createProject(fd);
        onClose();
      } catch {
        setError('Save failed.');
      }
    });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{isEdit ? 'Edit project' : 'New project'}</h2>
        <form onSubmit={onSubmit}>
          <div className="field">
            <label>Name</label>
            <input name="name" defaultValue={project?.name ?? ''} required autoFocus />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Domain</label>
              <input name="domain" defaultValue={project?.domain ?? ''} placeholder="example.com" />
            </div>
            <div className="field">
              <label>Category</label>
              <select name="category" defaultValue={project?.category ?? 'internal'}>
                {CATEGORIES.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Status</label>
              <select name="status" defaultValue={project?.status ?? 'prelaunch'}>
                {STATUS_OPTS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Accent</label>
              <select name="accent" defaultValue={project?.accent ?? 'orange'}>
                {ACCENT_OPTS.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Priority</label>
              <select name="priority" defaultValue={project?.priority ?? ''}>
                {PRIORITY_OPTS.map((p) => (
                  <option key={p || 'none'} value={p}>{p || '—'}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label>Tech stack (comma-separated)</label>
            <input name="techStack" defaultValue={(project?.techStack ?? []).join(', ')} placeholder="Next.js 15, Neon, R2" />
          </div>
          <div className="field">
            <label>Repo path</label>
            <input name="repoPath" defaultValue={project?.repoPath ?? ''} placeholder="/path/to/…" />
          </div>
          <div className="field-row">
            <div className="field">
              <label>Repo URL</label>
              <input name="repoUrl" defaultValue={project?.repoUrl ?? ''} />
            </div>
            <div className="field">
              <label>Live URL</label>
              <input name="liveUrl" defaultValue={project?.liveUrl ?? ''} />
            </div>
          </div>
          <div className="field">
            <label>Notes</label>
            <textarea name="notes" rows={2} defaultValue={project?.notes ?? ''} />
          </div>
          {error && <p className="modal-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-accent" disabled={pending}>
              {pending ? 'Saving…' : isEdit ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

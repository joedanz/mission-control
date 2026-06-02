'use client';

// ABOUTME: Per-project Edit + Delete controls (used on the desktop card).

import { useState, useTransition } from 'react';
import { ProjectModal } from './ProjectModal';
import { deleteProject } from '@/app/actions';
import type { Project } from '@/lib/db/schema';

export function ProjectCardActions({ project }: { project: Project }) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();

  function onDelete() {
    if (!confirm(`Delete "${project.name}" and all its tasks?`)) return;
    startTransition(() => {
      void deleteProject(project.id);
    });
  }

  return (
    <>
      <button type="button" className="btn" onClick={() => setEditing(true)}>
        Edit
      </button>
      <button type="button" className="btn btn-danger" disabled={pending} onClick={onDelete}>
        Delete
      </button>
      {editing && <ProjectModal project={project} onClose={() => setEditing(false)} />}
    </>
  );
}

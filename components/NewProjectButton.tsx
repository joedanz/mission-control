'use client';

// ABOUTME: Header "New project" button — opens the create modal.

import { useState } from 'react';
import { ProjectModal } from './ProjectModal';

export function NewProjectButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-accent" onClick={() => setOpen(true)}>
        + New
      </button>
      {open && <ProjectModal onClose={() => setOpen(false)} />}
    </>
  );
}

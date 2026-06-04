'use client';

// ABOUTME: Inline "add task" input for a project card.

import { useState, useTransition } from 'react';
import { addTask } from '@/app/actions';

export function AddTask({ projectId, onAdded }: { projectId: string; onAdded?: () => void }) {
  const [label, setLabel] = useState('');
  const [pending, startTransition] = useTransition();

  function submit() {
    const value = label.trim();
    if (!value) return;
    setLabel('');
    startTransition(() => {
      void addTask(projectId, value).then(() => onAdded?.());
    });
  }

  return (
    <div className="add-task">
      <input
        value={label}
        placeholder="Add a task…"
        aria-label="Add a task"
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button type="button" className="btn" disabled={pending} onClick={submit}>
        Add
      </button>
    </div>
  );
}

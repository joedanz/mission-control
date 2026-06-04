'use client';

// ABOUTME: A single task row with an optimistic toggle checkbox, label, and delete button.
// ABOUTME: 44px touch targets; delete is always visible (touch devices have no hover).

import { useState, useTransition } from 'react';
import { toggleTask, deleteTask } from '@/app/actions';

type Props = {
  id: string;
  label: string;
  notes?: string | null;
  done: boolean;
  onChanged?: () => void;
};

export function TaskItem({ id, label, notes, done, onChanged }: Props) {
  const [optimisticDone, setOptimisticDone] = useState(done);
  const [, startTransition] = useTransition();

  function onToggle() {
    setOptimisticDone((d) => !d);
    startTransition(() => {
      void toggleTask(id).then(() => onChanged?.());
    });
  }

  function onDelete() {
    startTransition(() => {
      void deleteTask(id).then(() => onChanged?.());
    });
  }

  return (
    <li className={`task${optimisticDone ? ' done' : ''}`}>
      <button
        type="button"
        role="checkbox"
        aria-checked={optimisticDone}
        aria-label={`${optimisticDone ? 'Mark incomplete' : 'Mark complete'}: ${label}`}
        className="task-box"
        onClick={onToggle}
      >
        <span className="box" aria-hidden="true" />
      </button>
      <span className="task-text" onClick={onToggle}>
        {label}
        {notes ? <span className="note">{notes}</span> : null}
      </span>
      <button type="button" className="task-del" aria-label={`Delete task: ${label}`} onClick={onDelete}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
        </svg>
      </button>
    </li>
  );
}

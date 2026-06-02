'use client';

// ABOUTME: One Kanban column — a droppable list with a SortableContext over its cards. Reused by the
// ABOUTME: per-project board (status columns) and the overall board (per-lane mini columns).

import type React from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { BoardCard, type Claimant } from './BoardCard';
import type { BoardTask } from '@/lib/board';

export function BoardColumn({
  status,
  label,
  tasks,
  claimantFor,
  projectNameFor,
  headerExtra,
  droppableId,
}: {
  status: string;
  label: string;
  tasks: BoardTask[];
  claimantFor: (t: BoardTask) => Claimant;
  projectNameFor?: (t: BoardTask) => string | undefined;
  headerExtra?: React.ReactNode;
  // Unique droppable id; defaults to `col:<status>`. Swimlanes pass a lane-scoped id.
  droppableId?: string;
}) {
  const dropId = droppableId ?? `col:${status}`;
  const { setNodeRef, isOver } = useDroppable({ id: dropId });

  return (
    <section className={`board-col${isOver ? ' over' : ''}`} aria-label={label}>
      <header className="board-col-head">
        <span className="board-col-title">{label}</span>
        <span className="board-col-count">{tasks.length}</span>
        {headerExtra}
      </header>
      <SortableContext id={dropId} items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <ul ref={setNodeRef} className="board-col-list">
          {tasks.map((t) => (
            <BoardCard key={t.id} task={t} claimant={claimantFor(t)} projectName={projectNameFor?.(t)} />
          ))}
          {tasks.length === 0 && <li className="board-col-empty" aria-hidden="true">—</li>}
        </ul>
      </SortableContext>
    </section>
  );
}

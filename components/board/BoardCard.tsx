'use client';

// ABOUTME: A single draggable Kanban card. Live-claimed cards are drag-locked (never fight a running
// ABOUTME: agent) and show the claimant agent chip with a pulsing live dot linking to the run.

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { BoardTask, Claimant } from '@/lib/board';

export type { Claimant };

export function BoardCard({
  task,
  claimant,
  projectName,
}: {
  task: BoardTask;
  claimant: Claimant;
  projectName?: string;
}) {
  const locked = !!claimant; // a live claim drag-locks the card (server enforces too)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: locked,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`board-card${isDragging ? ' dragging' : ''}${locked ? ' locked' : ''}`}
      title={locked ? `claimed by ${claimant!.agentLabel} — release the agent to move` : undefined}
      {...(locked ? {} : attributes)}
      {...(locked ? {} : listeners)}
    >
      <span className="board-card-label">{task.label}</span>
      {task.notes && <span className="board-card-note">{task.notes}</span>}
      <span className="board-card-foot">
        {projectName && <span className="board-card-proj">{projectName}</span>}
        {claimant && (
          <a
            className="board-card-agent"
            href={`/runs/${claimant.runId}`}
            // don't let a click on the chip start a drag
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span className="sig-dot pulse-dot" />
            {claimant.agentLabel}
          </a>
        )}
      </span>
    </li>
  );
}

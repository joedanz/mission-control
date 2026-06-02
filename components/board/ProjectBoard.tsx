'use client';

// ABOUTME: Per-project Kanban board — three status columns with drag-to-move (status change) and
// ABOUTME: drag-to-reorder (sortOrder, which steers the auto-claim queue). Optimistic via useBoard;
// ABOUTME: live-claimed cards are drag-locked. Keyboard-draggable with label-aware announcements.

import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragEndEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useBoard } from '@/lib/useBoard';
import {
  BOARD_COLUMNS,
  buildAnnouncements,
  claimantResolver,
  columnLabel,
  planDrop,
  type BoardData,
  type BoardTask,
} from '@/lib/board';
import { moveTask as moveTaskAction } from '@/app/actions';
import { BoardColumn } from './BoardColumn';

const DONE_WINDOWS = [
  { key: '10', label: 'last 10' },
  { key: '25', label: 'last 25' },
  { key: '50', label: 'last 50' },
  { key: 'today', label: 'today' },
  { key: '7d', label: '7 days' },
  { key: 'all', label: 'all' },
] as const;

function applyDoneWindow(done: BoardTask[], win: string): BoardTask[] {
  if (win === 'all') return done;
  if (win === 'today') {
    const t0 = new Date();
    t0.setHours(0, 0, 0, 0);
    return done.filter((d) => d.completedAt && new Date(d.completedAt) >= t0);
  }
  if (win === '7d') {
    const cutoff = Date.now() - 7 * 86_400_000;
    return done.filter((d) => d.completedAt && new Date(d.completedAt).getTime() >= cutoff);
  }
  const n = parseInt(win, 10);
  return Number.isFinite(n) ? done.slice(0, n) : done;
}

export function ProjectBoard({
  slug,
  initial,
  integrations,
}: {
  slug: string;
  initial: BoardData;
  integrations: { done: number; total: number };
}) {
  const { projects, runs, error, applyMove, reload } = useBoard({ projectSlug: slug, initial });
  const project = projects[0];
  const tasks = useMemo(() => project?.tasks ?? [], [project]);

  // Done-window: render the default on first paint, then read localStorage in an effect (no SSR mismatch).
  const storageKey = `mc.board.doneWindow.${slug}`;
  const [doneWindow, setDoneWindow] = useState<string>('10');
  useEffect(() => {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(storageKey) : null;
    // Reading persisted prefs after mount is the sanctioned setState-in-effect (avoids SSR mismatch).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (v) setDoneWindow(v);
  }, [storageKey]);
  function changeDoneWindow(v: string) {
    setDoneWindow(v);
    try {
      window.localStorage.setItem(storageKey, v);
    } catch {
      /* private mode / quota — non-fatal */
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const claimantFor = useMemo(() => claimantResolver(runs), [runs]);

  const announcements = useMemo(() => {
    const labelOf = (id: string | number) => tasks.find((t) => t.id === String(id))?.label ?? 'task';
    const targetOf = (id: string | number) => {
      const s = String(id);
      return s.startsWith('col:') ? columnLabel(s.slice(4)) : labelOf(s);
    };
    return buildAnnouncements(labelOf, targetOf);
  }, [tasks]);

  const inColumn = (status: string) => {
    const list = tasks.filter((t) => t.status === status);
    if (status === 'done') {
      const sorted = [...list].sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
      return applyDoneWindow(sorted, doneWindow);
    }
    return [...list].sort((a, b) => a.sortOrder - b.sortOrder);
  };

  function statusOf(overId: string): string | null {
    if (overId.startsWith('col:')) return overId.slice(4);
    return tasks.find((t) => t.id === overId)?.status ?? null;
  }

  async function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const destStatus = statusOf(overId);
    if (!destStatus) return;

    const plan = planDrop(tasks, activeId, overId, destStatus, overId.startsWith('col:'));
    if (!plan) return; // not found, or dropped back in place

    applyMove(activeId, plan.statusChanged ? destStatus : undefined, plan.orderedIds);
    const res = await moveTaskAction(activeId, {
      toStatus: plan.statusChanged ? (destStatus as BoardTask['status']) : undefined,
      orderedIds: plan.orderedIds,
      expectedVersion: plan.statusChanged ? plan.version : undefined,
    });
    if (!res.ok) reload(); // version conflict or live-claim refusal → resync from the server
  }

  const doneTotal = tasks.filter((t) => t.status === 'done').length;
  const doneShown = inColumn('done').length;

  return (
    <div className="board">
      <div className="board-toolbar">
        <a className="board-intg" href="?tab=integrations" title="integration readiness">
          Integrations {integrations.done}/{integrations.total}
        </a>
        <label className="board-donewin">
          Done:
          <select value={doneWindow} onChange={(e) => changeDoneWindow(e.target.value)}>
            {DONE_WINDOWS.map((w) => (
              <option key={w.key} value={w.key}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        {error && <span className="board-err">sync error</span>}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragEnd={onDragEnd}
        accessibility={{ announcements }}
      >
        <div className="board-cols">
          {BOARD_COLUMNS.map((c) => (
            <BoardColumn
              key={c.key}
              status={c.key}
              label={c.label}
              tasks={inColumn(c.key)}
              claimantFor={claimantFor}
              headerExtra={
                c.key === 'done' && doneTotal > doneShown ? (
                  <span className="board-col-more">of {doneTotal}</span>
                ) : undefined
              }
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}

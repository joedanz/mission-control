'use client';

// ABOUTME: All-projects Kanban — one swimlane (row) per project, each with the 3 status columns.
// ABOUTME: Drag is restricted to within a lane (a task can't change project). Lanes are memoized so a
// ABOUTME: poll that didn't change lane X doesn't re-render it. A shared Fleet rail sits on top.

import { memo, useMemo } from 'react';
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
  sortColumnTasks,
  type BoardData,
  type BoardProject,
  type BoardTask,
  type Claimant,
} from '@/lib/board';
import { moveTask as moveTaskAction } from '@/app/actions';
import { BoardColumn } from './BoardColumn';
import { FleetRail } from '@/components/FleetRail';

// One project row. Memoized on the lane's task identity + the claimant resolver so unrelated polls
// don't re-render every lane.
const Lane = memo(function Lane({
  project,
  claimantFor,
}: {
  project: BoardProject;
  claimantFor: (t: BoardTask) => Claimant;
}) {
  return (
    <div className="board-lane">
      <div className="board-lane-head">
        <a className="board-lane-name" href={`/p/${project.slug}`}>
          {project.name}
        </a>
      </div>
      {BOARD_COLUMNS.map((c) => (
        <BoardColumn
          key={c.key}
          status={c.key}
          label={c.label}
          tasks={sortColumnTasks(
            project.tasks.filter((t) => t.status === c.key),
            c.key,
          )}
          claimantFor={claimantFor}
          // Lane-scoped droppable id so columns across lanes don't collide.
          droppableId={`lane:${project.slug}:${c.key}`}
        />
      ))}
    </div>
  );
});

export function OverallBoard({ initial }: { initial: BoardData }) {
  // Heavier payload than the Mission feed → poll a bit slower. Single poller feeds both board + rail.
  const { projects, runs, error, applyMove, reload } = useBoard({ initial, intervalMs: 6000 });
  const claimantFor = useMemo(() => claimantResolver(runs), [runs]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const announcements = useMemo(() => {
    const labelOf = (id: string | number) => {
      const s = String(id);
      for (const p of projects) {
        const t = p.tasks.find((x) => x.id === s);
        if (t) return t.label;
      }
      return 'task';
    };
    const targetOf = (id: string | number) => {
      const s = String(id);
      return s.startsWith('lane:') ? columnLabel(s.split(':')[2]) : labelOf(s);
    };
    return buildAnnouncements(labelOf, targetOf);
  }, [projects]);

  // Map any droppable/task id back to {slug, status}. Column ids are `lane:<slug>:<status>`.
  function locate(id: string): { slug: string; status: string } | null {
    if (id.startsWith('lane:')) {
      const [, slug, status] = id.split(':');
      return { slug, status };
    }
    for (const p of projects) {
      const t = p.tasks.find((x) => x.id === id);
      if (t) return { slug: p.slug, status: t.status };
    }
    return null;
  }

  async function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const from = locate(activeId);
    const to = locate(overId);
    if (!from || !to) return;
    if (from.slug !== to.slug) return; // a task can't change project — ignore cross-lane drops

    const project = projects.find((p) => p.slug === to.slug);
    if (!project) return;

    const plan = planDrop(project.tasks, activeId, overId, to.status, overId.startsWith('lane:'));
    if (!plan) return;

    applyMove(activeId, plan.statusChanged ? to.status : undefined, plan.orderedIds);
    const res = await moveTaskAction(activeId, {
      toStatus: plan.statusChanged ? to.status : undefined,
      orderedIds: plan.orderedIds,
      expectedVersion: plan.statusChanged ? plan.version : undefined,
    });
    if (!res.ok) reload();
  }

  return (
    <div className="board">
      <FleetRail runs={runs} loaded />
      {error && <p className="board-err">sync error — retrying</p>}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragEnd={onDragEnd}
        accessibility={{ announcements }}
      >
        <div className="board-lanes">
          {projects.length === 0 ? (
            <p className="detail-muted">No active projects.</p>
          ) : (
            projects.map((p) => <Lane key={p.slug} project={p} claimantFor={claimantFor} />)
          )}
        </div>
      </DndContext>
    </div>
  );
}

'use client';

// ABOUTME: Live list view for the unified Tasks tab. Reads the same useBoard poll the Board uses
// ABOUTME: (so toggling between views is always consistent), renders TaskItem rows + AddTask, and
// ABOUTME: refetches immediately after a mutation via the hook's reload().

import { useBoard } from '@/lib/useBoard';
import { toListRows } from '@/lib/task-view';
import type { BoardData } from '@/lib/board';
import { TaskItem } from '@/components/TaskItem';
import { AddTask } from '@/components/AddTask';

export function TaskListView({
  slug,
  projectId,
  initial,
}: {
  slug: string;
  projectId: string;
  initial: BoardData;
}) {
  const { projects, reload } = useBoard({ projectSlug: slug, initial });
  const rows = toListRows(projects[0]?.tasks ?? []);

  return (
    <div className="detail-tasks">
      {rows.length > 0 ? (
        <ul className="tasklist">
          {rows.map((t) => (
            // key includes done so a remote status change remounts the row with fresh optimistic state
            <TaskItem key={`${t.id}:${t.done}`} id={t.id} label={t.label} notes={t.notes} done={t.done} onChanged={reload} />
          ))}
        </ul>
      ) : (
        <p className="detail-muted">No tasks yet.</p>
      )}
      <AddTask projectId={projectId} onAdded={reload} />
    </div>
  );
}

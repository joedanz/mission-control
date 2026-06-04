'use client';

// ABOUTME: Unified Tasks tab: a List ⇄ Board pill toggle over one dataset. View choice is persisted
// ABOUTME: per-project in localStorage (mc.taskView.<slug>); a legacy ?tab=board deep-link forces the
// ABOUTME: Board view once (without overwriting the stored pref). Both views share the live useBoard data.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { BoardData } from '@/lib/board';
import {
  taskViewStorageKey,
  resolveInitialTaskView,
  type TaskView,
} from '@/lib/task-view';
import { TaskListView } from '@/components/TaskListView';
import { ProjectBoard } from '@/components/board/ProjectBoard';

export function TasksPanel({
  slug,
  projectId,
  initial,
  integrations,
}: {
  slug: string;
  projectId: string;
  initial: BoardData;
  integrations: { done: number; total: number };
}) {
  const sp = useSearchParams();
  const legacyBoard = sp.get('tab') === 'board';
  // Deterministic first paint (server + client agree on sp): default list, or board for a legacy link.
  const [view, setView] = useState<TaskView>(legacyBoard ? 'board' : 'list');
  const storageKey = taskViewStorageKey(slug);

  // After mount, apply the stored per-project pref — unless a legacy ?tab=board link is overriding it.
  useEffect(() => {
    if (legacyBoard) return;
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(storageKey) : null;
    // Reading persisted prefs after mount is the sanctioned setState-in-effect (avoids SSR mismatch).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setView(resolveInitialTaskView({ stored }));
  }, [storageKey, legacyBoard]);

  function changeView(v: TaskView) {
    setView(v);
    try {
      window.localStorage.setItem(storageKey, v);
    } catch {
      /* private mode / quota — non-fatal */
    }
  }

  return (
    <>
      <div className="view-toggle" role="group" aria-label="Task view">
        <button
          type="button"
          aria-pressed={view === 'list'}
          className={view === 'list' ? 'on' : ''}
          onClick={() => changeView('list')}
        >
          List
        </button>
        <button
          type="button"
          aria-pressed={view === 'board'}
          className={view === 'board' ? 'on' : ''}
          onClick={() => changeView('board')}
        >
          Board
        </button>
      </div>
      {view === 'list' ? (
        <TaskListView slug={slug} projectId={projectId} initial={initial} />
      ) : (
        <ProjectBoard slug={slug} initial={initial} integrations={integrations} />
      )}
    </>
  );
}

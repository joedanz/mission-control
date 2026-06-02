// ABOUTME: Shared, framework-agnostic board shapes + the ProjectWithTasks → BoardProject projection.
// ABOUTME: Type-only imports from queries/useActivityFeed (erased), so this is safe in server routes,
// ABOUTME: server components, AND client components — one source of truth for the board payload.

import type { ProjectWithTasks } from './queries';
import type { FeedRun } from './useActivityFeed';

// Overall board caps each project's Done column so the all-projects payload stays bounded; the
// per-project board (a single slug) returns everything and lets the client window it.
export const OVERALL_DONE_CAP = 50;

export type BoardTask = {
  id: string;
  label: string;
  notes: string | null;
  status: string;
  sortOrder: number;
  projectId: string;
  claimedByRunId: string | null;
  version: number;
  completedAt: string | null;
};

export type BoardProject = {
  slug: string;
  name: string;
  accent: string;
  integrations: { done: number; total: number };
  tasks: BoardTask[];
};

export type BoardData = { projects: BoardProject[]; runs: FeedRun[] };

// A task's live claimant (the agent on it now), or null. Shared by the card + both boards.
export type Claimant = { runId: string; agentLabel: string } | null;

/** Project a full ProjectWithTasks into the lean board shape: custom tasks only, integration tasks
 *  collapsed to an N/M readiness count. When `capDone`, keep only the most-recently-completed Done tasks
 *  (overall board); per-project boards pass false and window client-side. */
export function toBoardProject(p: ProjectWithTasks, capDone: boolean): BoardProject {
  const custom = p.tasks.filter((t) => !t.integrationType);
  const integration = p.tasks.filter((t) => t.integrationType);
  let tasks = custom;
  if (capDone) {
    const done = custom
      .filter((t) => t.status === 'done')
      .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))
      .slice(0, OVERALL_DONE_CAP);
    tasks = [...custom.filter((t) => t.status !== 'done'), ...done];
  }
  return {
    slug: p.slug,
    name: p.name,
    accent: p.accent,
    integrations: {
      done: integration.filter((t) => t.integrationStatus === 'done').length,
      total: integration.length,
    },
    tasks: tasks.map((t) => ({
      id: t.id,
      label: t.label,
      notes: t.notes,
      status: t.status,
      sortOrder: t.sortOrder,
      projectId: t.projectId,
      claimedByRunId: t.claimedByRunId,
      version: t.version,
      completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    })),
  };
}

// ── Shared board view logic (used by both ProjectBoard and OverallBoard) ──────

export const BOARD_COLUMNS = [
  { key: 'todo', label: 'To Do' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'done', label: 'Done' },
] as const;

export function columnLabel(status: string): string {
  return BOARD_COLUMNS.find((c) => c.key === status)?.label ?? status;
}

// Resolve each task's LIVE claimant. Builds a run lookup once so the returned resolver is O(1) per
// task (O(tasks + runs) overall) instead of a linear runs.find() per card.
export function claimantResolver(runs: FeedRun[]): (t: BoardTask) => Claimant {
  const liveById = new Map<string, FeedRun>();
  for (const r of runs) if (r.live) liveById.set(r.id, r);
  return (t) => {
    if (!t.claimedByRunId) return null;
    const run = liveById.get(t.claimedByRunId);
    return run ? { runId: run.id, agentLabel: run.agentLabel } : null;
  };
}

// Order a column's cards: Done is newest-first by completedAt; the rest by sortOrder.
export function sortColumnTasks(tasks: BoardTask[], status: string): BoardTask[] {
  return [...tasks].sort((a, b) =>
    status === 'done'
      ? (b.completedAt ?? '').localeCompare(a.completedAt ?? '')
      : a.sortOrder - b.sortOrder,
  );
}

export type DropPlan = { orderedIds: string[]; statusChanged: boolean; version: number };

// Pure drag-drop resolution: given a project's tasks and where `activeId` was dropped (over a card or
// the column body, `overIsColumn`), return the destination column's new id ordering, whether the
// status changed, and the moved card's version (for optimistic concurrency). Null for a no-op reorder.
export function planDrop(
  tasks: BoardTask[],
  activeId: string,
  overId: string,
  toStatus: string,
  overIsColumn: boolean,
): DropPlan | null {
  const moved = tasks.find((t) => t.id === activeId);
  if (!moved) return null;

  const destTasks = tasks.filter((t) => t.status === toStatus);
  const others = destTasks
    .filter((t) => t.id !== activeId)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  let insertAt = others.length;
  if (!overIsColumn) {
    const overIdx = others.findIndex((t) => t.id === overId);
    if (overIdx >= 0) insertAt = overIdx;
  }
  const orderedIds = [
    ...others.slice(0, insertAt).map((t) => t.id),
    activeId,
    ...others.slice(insertAt).map((t) => t.id),
  ];

  const statusChanged = toStatus !== moved.status;
  if (!statusChanged) {
    const current = destTasks
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((t) => t.id);
    if (current.join(',') === orderedIds.join(',')) return null; // dropped where it already was
  }
  return { orderedIds, statusChanged, version: moved.version };
}

// dnd-kit accessibility announcement builders. `labelOf` resolves a card id to its label; `targetOf`
// resolves a drop-target id (card or column) to a spoken name.
type AnnId = { id: string | number };
export function buildAnnouncements(
  labelOf: (id: string | number) => string,
  targetOf: (id: string | number) => string,
) {
  return {
    onDragStart: ({ active }: { active: AnnId }) =>
      `Picked up ${labelOf(active.id)}. Use arrow keys to move, space to drop.`,
    onDragOver: ({ active, over }: { active: AnnId; over: AnnId | null }) =>
      over ? `${labelOf(active.id)} moved over ${targetOf(over.id)}.` : '',
    onDragEnd: ({ active, over }: { active: AnnId; over: AnnId | null }) =>
      over ? `${labelOf(active.id)} dropped over ${targetOf(over.id)}.` : `${labelOf(active.id)} dropped.`,
    onDragCancel: ({ active }: { active: AnnId }) => `Dragging ${labelOf(active.id)} cancelled.`,
  };
}

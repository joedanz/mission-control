// lib/task-view.ts
// ABOUTME: Pure helpers for the unified Tasks tab (List ⇄ Board). Per-project localStorage key,
// ABOUTME: view parsing/resolution (legacy ?tab=board override + stored pref + default list), and
// ABOUTME: the BoardTask → list-row projection the live TaskListView renders. No React/DOM.

import type { BoardTask } from './board';

export const TASK_VIEWS = ['list', 'board'] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

export function taskViewStorageKey(slug: string): string {
  return `mc.taskView.${slug}`;
}

export function parseTaskView(raw: string | null | undefined): TaskView | null {
  return raw === 'list' || raw === 'board' ? raw : null;
}

export function resolveInitialTaskView(opts: { stored?: string | null; legacyBoard?: boolean }): TaskView {
  if (opts.legacyBoard) return 'board';
  return parseTaskView(opts.stored) ?? 'list';
}

export type TaskListRow = { id: string; label: string; notes: string | null; done: boolean };

export function toListRows(tasks: BoardTask[]): TaskListRow[] {
  return [...tasks]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((t) => ({ id: t.id, label: t.label, notes: t.notes, done: t.status === 'done' }));
}

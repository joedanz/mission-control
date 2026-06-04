// test/task-view.test.ts
// ABOUTME: Unit tests for the unified Tasks-tab view helpers — storage-key shape, view parsing,
// ABOUTME: initial-view resolution (legacy ?tab=board override + stored pref + default), and the
// ABOUTME: BoardTask → list-row projection. Pure (no DOM / no DB).

import { describe, it, expect } from 'vitest';
import {
  taskViewStorageKey,
  parseTaskView,
  resolveInitialTaskView,
  toListRows,
} from '../lib/task-view';
import type { BoardTask } from '../lib/board';

function task(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 't1', label: 'Task', notes: null, status: 'todo', sortOrder: 0,
    projectId: 'p1', claimedByRunId: null, version: 0, completedAt: null,
    ...overrides,
  };
}

describe('taskViewStorageKey', () => {
  it('is per-project and dot-namespaced', () => {
    expect(taskViewStorageKey('acme')).toBe('mc.taskView.acme');
    expect(taskViewStorageKey('beta')).not.toBe(taskViewStorageKey('acme'));
  });
});

describe('parseTaskView', () => {
  it('accepts the two valid views', () => {
    expect(parseTaskView('list')).toBe('list');
    expect(parseTaskView('board')).toBe('board');
  });
  it('rejects anything else as null', () => {
    expect(parseTaskView('grid')).toBeNull();
    expect(parseTaskView(null)).toBeNull();
    expect(parseTaskView(undefined)).toBeNull();
  });
});

describe('resolveInitialTaskView', () => {
  it('defaults to list with no stored pref', () => {
    expect(resolveInitialTaskView({})).toBe('list');
  });
  it('uses the stored pref when valid', () => {
    expect(resolveInitialTaskView({ stored: 'board' })).toBe('board');
  });
  it('ignores an invalid stored pref', () => {
    expect(resolveInitialTaskView({ stored: 'bogus' })).toBe('list');
  });
  it('legacy ?tab=board overrides the stored pref', () => {
    expect(resolveInitialTaskView({ stored: 'list', legacyBoard: true })).toBe('board');
  });
});

describe('toListRows', () => {
  it('orders by sortOrder and flags done by status', () => {
    const rows = toListRows([
      task({ id: 'b', sortOrder: 2, status: 'done' }),
      task({ id: 'a', sortOrder: 1, status: 'in_progress' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[0].done).toBe(false);
    expect(rows[1].done).toBe(true);
  });
  it('carries id/label/notes through', () => {
    const [row] = toListRows([task({ id: 'x', label: 'Ship it', notes: 'soon' })]);
    expect(row).toEqual({ id: 'x', label: 'Ship it', notes: 'soon', done: false });
  });
  it('does not mutate its input', () => {
    const input = [task({ id: 'b', sortOrder: 2 }), task({ id: 'a', sortOrder: 1 })];
    toListRows(input);
    expect(input.map((t) => t.id)).toEqual(['b', 'a']);
  });
});

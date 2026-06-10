// ABOUTME: Pure unit tests for planDrop (lib/board.ts) — the drag-drop ordering math BOTH boards call. No DB.
// ABOUTME: Pins the dnd-kit arrayMove semantics + the self-drop guard the audit (M14) corrected: a downward
// ABOUTME: drag lands AFTER the over card (not one slot short), a one-slot-down drag is a real move (not a
// ABOUTME: no-op snapback), an upward/cross-column drop lands AT the over card, and a self-drop is a no-op.

import { describe, it, expect } from 'vitest';
import { planDrop } from '../lib/board';
import type { BoardTask } from '../lib/board';

const task = (id: string, status: string, sortOrder: number): BoardTask => ({
  id, label: id, notes: null, status, sortOrder, projectId: 'p', claimedByRunId: null, version: 0, completedAt: null,
});

// Column "todo" = [A, B, C] by sortOrder.
const cols = () => [task('A', 'todo', 0), task('B', 'todo', 1), task('C', 'todo', 2)];

describe('planDrop — same-column reorder (arrayMove semantics)', () => {
  it('dragging A down over C lands A AFTER C → [B, C, A] (was one slot short)', () => {
    const plan = planDrop(cols(), 'A', 'C', 'todo', false);
    expect(plan?.orderedIds).toEqual(['B', 'C', 'A']);
  });

  it('dragging A down exactly one slot over B → [B, A, C] (a real move, not a no-op snapback)', () => {
    const plan = planDrop(cols(), 'A', 'B', 'todo', false);
    expect(plan?.orderedIds).toEqual(['B', 'A', 'C']);
  });

  it('dragging C up over A lands C AT A → [C, A, B]', () => {
    const plan = planDrop(cols(), 'C', 'A', 'todo', false);
    expect(plan?.orderedIds).toEqual(['C', 'A', 'B']);
  });

  it('a self-drop (over the card itself) is a no-op (null), not an append-to-end', () => {
    expect(planDrop(cols(), 'A', 'A', 'todo', false)).toBeNull();
  });

  it('dropping on the column body appends to the end', () => {
    const plan = planDrop(cols(), 'A', 'col:todo', 'todo', true);
    expect(plan?.orderedIds).toEqual(['B', 'C', 'A']);
  });
});

describe('planDrop — cross-column move', () => {
  it('dropping A onto an in_progress card inserts AT that card (before it)', () => {
    const tasks = [...cols(), task('X', 'in_progress', 0), task('Y', 'in_progress', 1)];
    const plan = planDrop(tasks, 'A', 'Y', 'in_progress', false);
    expect(plan?.statusChanged).toBe(true);
    expect(plan?.orderedIds).toEqual(['X', 'A', 'Y']);
  });

  it('dropping A onto an empty column places it alone', () => {
    const plan = planDrop(cols(), 'A', 'col:done', 'done', true);
    expect(plan?.statusChanged).toBe(true);
    expect(plan?.orderedIds).toEqual(['A']);
  });
});

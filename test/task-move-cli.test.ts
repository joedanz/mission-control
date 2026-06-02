// ABOUTME: Unit tests for the `mc task move` ordering helper (planMoveOrder) — the pure piece that turns
// ABOUTME: --top/--after into the destination column's new id ordering. No DB; the write path itself
// ABOUTME: (moveTask) is covered against live Neon in board.test.ts.

import { describe, it, expect } from 'vitest';
import { planMoveOrder } from '../cli/index';
import { ValidationError } from '../lib/validation';

const COLUMN = ['a', 'b', 'c']; // dest column siblings, in sortOrder, moved id excluded

describe('planMoveOrder', () => {
  it('--top places the moved card first', () => {
    expect(planMoveOrder(COLUMN, 'x', { top: true })).toEqual(['x', 'a', 'b', 'c']);
  });

  it('--top onto an empty column yields just the moved card', () => {
    expect(planMoveOrder([], 'x', { top: true })).toEqual(['x']);
  });

  it('--after inserts immediately after the named sibling', () => {
    expect(planMoveOrder(COLUMN, 'x', { after: 'b' })).toEqual(['a', 'b', 'x', 'c']);
  });

  it('--after the last sibling appends', () => {
    expect(planMoveOrder(COLUMN, 'x', { after: 'c' })).toEqual(['a', 'b', 'c', 'x']);
  });

  it('--after a sibling that is not in the destination column is a ValidationError', () => {
    expect(() => planMoveOrder(COLUMN, 'x', { after: 'zzz' })).toThrow(ValidationError);
  });

  it('no placement (pure status change) returns undefined — leaves sortOrder untouched', () => {
    expect(planMoveOrder(COLUMN, 'x', {})).toBeUndefined();
  });
});

// ABOUTME: Pure-logic tests for branch-condition evaluation (slice 6a) — operator semantics, type-preserving
// ABOUTME: {{ref}} operands, first-match-wins case selection, the implicit 'else', and missing-ref hard fail.
// ABOUTME: No DB, no spawn (mirrors test/workflow-refs.test.ts). The substrate is the same RefView map.

import { describe, it, expect } from 'vitest';
import { evaluateCondition, chooseBranch, ELSE } from '../lib/workflow-branch';
import { normalizeStepOutput, type RefView } from '../lib/workflow-refs';
import type { BranchCase, BranchCondition } from '../lib/db/schema';

// A views map with one upstream agent node `a` whose structured output carries { score, label, tags }.
function views(structured: Record<string, unknown>): Map<string, RefView> {
  const m = new Map<string, RefView>();
  m.set('a', normalizeStepOutput({ runId: 'r', runStatus: 'completed', result: { type: 'result', result: 'free', structured_output: structured } }));
  return m;
}

const cond = (left: unknown, op: BranchCondition['op'], right?: unknown): BranchCondition => ({ left, op, right });

describe('workflow-branch — evaluateCondition operators', () => {
  const v = views({ score: 88, label: 'green', tags: ['a', 'b'] });

  it('compares a typed numeric ref operand numerically', () => {
    expect(evaluateCondition(cond('{{a.output.score}}', 'gte', 80), v).value).toBe(true);
    expect(evaluateCondition(cond('{{a.output.score}}', 'gt', 88), v).value).toBe(false);
    expect(evaluateCondition(cond('{{a.output.score}}', 'lt', 90), v).value).toBe(true);
  });

  it('eq is numeric when both look numeric, else string', () => {
    expect(evaluateCondition(cond('{{a.output.score}}', 'eq', '88'), v).value).toBe(true); // 88 === "88"
    expect(evaluateCondition(cond('{{a.output.label}}', 'eq', 'green'), v).value).toBe(true);
    expect(evaluateCondition(cond('{{a.output.label}}', 'ne', 'red'), v).value).toBe(true);
  });

  it('contains works on arrays (membership) and strings (substring)', () => {
    expect(evaluateCondition(cond('{{a.output.tags}}', 'contains', 'b'), v).value).toBe(true);
    expect(evaluateCondition(cond('{{a.output.tags}}', 'contains', 'z'), v).value).toBe(false);
    expect(evaluateCondition(cond('{{a.output.label}}', 'contains', 'ree'), v).value).toBe(true);
  });

  it('truthy/falsy ignore right and read JS truthiness', () => {
    expect(evaluateCondition(cond('{{a.output.label}}', 'truthy'), v).value).toBe(true);
    expect(evaluateCondition(cond('{{a.output.label}}', 'falsy'), v).value).toBe(false);
  });

  it('a numeric op on a non-numeric operand is false, never an error', () => {
    expect(evaluateCondition(cond('{{a.output.label}}', 'gt', 5), v).value).toBe(false);
  });

  it('surfaces a missing ref (unknown field) for the walker to hard-fail', () => {
    const r = evaluateCondition(cond('{{a.output.missing}}', 'gt', 5), v);
    expect(r.missing.length).toBeGreaterThan(0);
  });
});

describe('workflow-branch — chooseBranch', () => {
  const v = views({ score: 65 });
  const cases: BranchCase[] = [
    { name: 'high', when: cond('{{a.output.score}}', 'gte', 80) },
    { name: 'mid', when: cond('{{a.output.score}}', 'gte', 50) },
  ];

  it('returns the first matching case name', () => {
    expect(chooseBranch(cases, v).chosen).toBe('mid');
  });

  it('falls back to else when no case matches', () => {
    expect(chooseBranch(cases, views({ score: 10 })).chosen).toBe(ELSE);
  });

  it('short-circuits to a hard fail (missing) when a condition ref is unresolved', () => {
    const bad: BranchCase[] = [{ name: 'x', when: cond('{{a.output.nope}}', 'gt', 1) }];
    const r = chooseBranch(bad, v);
    expect(r.missing.length).toBeGreaterThan(0);
  });
});

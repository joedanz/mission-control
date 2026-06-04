// ABOUTME: Pure branch-condition logic (slice 6a) — evaluates a branch node's ordered cases against the
// ABOUTME: {{nodeId.field}} ref substrate and returns the chosen case name (or 'else'). Operands resolve
// ABOUTME: TYPE-PRESERVING via interpolateValue (so a {{a.output.score}} ref compares as a number), and a
// ABOUTME: condition op never throws — a non-numeric numeric-compare just makes the case false. No DB, no
// ABOUTME: spawn, no React (mirrors lib/workflow-refs.ts). The walker turns `chosen` into the active edges.

import { interpolateValue, type RefView } from './workflow-refs';
import type { BranchCase, BranchCondition, BranchOp } from './db/schema';

// The implicit fallback handle when no case matches (reserved — readBranchNodeData forbids it as a case name).
export const ELSE = 'else';

/** Coerce to a finite number, or NaN (a numeric op on a non-numeric operand → false, never an error). */
function asNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/** Loose equality: numeric when BOTH operands look numeric (so 88 === "88"), else strict string compare. */
function looseEq(a: unknown, b: unknown): boolean {
  const na = asNum(a), nb = asNum(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a) === String(b);
}

/** Apply one operator to two already-resolved operands. Total (no throw) so routing is robust. */
function compare(op: BranchOp, left: unknown, right: unknown): boolean {
  switch (op) {
    case 'truthy': return Boolean(left);
    case 'falsy': return !left;
    case 'eq': return looseEq(left, right);
    case 'ne': return !looseEq(left, right);
    case 'gt': return asNum(left) > asNum(right);
    case 'gte': return asNum(left) >= asNum(right);
    case 'lt': return asNum(left) < asNum(right);
    case 'lte': return asNum(left) <= asNum(right);
    case 'contains':
      return Array.isArray(left) ? left.some((x) => looseEq(x, right)) : String(left).includes(String(right));
  }
}

/** Resolve a condition's operands ({{refs}} → typed values) and apply the op. A missing ref (the source was
 *  skipped/failed, or no such field) is surfaced in `missing` — the walker hard-fails the branch node, the
 *  same contract as an agent prompt or integration argument. `value` is meaningless when `missing` is set. */
export function evaluateCondition(cond: BranchCondition, views: Map<string, RefView>): { value: boolean; missing: string[] } {
  const left = interpolateValue(cond.left, views);
  const right = interpolateValue(cond.right, views); // undefined right (truthy/falsy) → { value: undefined }
  const missing = [...left.missing, ...right.missing];
  if (missing.length) return { value: false, missing };
  return { value: compare(cond.op, left.value, right.value), missing: [] };
}

/** Pick the winning case: the first whose condition is true (none → 'else'). A condition with an unresolved
 *  ref short-circuits to a hard fail (returned via `missing`) — the walker won't route on stale data. */
export function chooseBranch(cases: BranchCase[], views: Map<string, RefView>): { chosen: string; missing: string[] } {
  for (const c of cases) {
    const { value, missing } = evaluateCondition(c.when, views);
    if (missing.length) return { chosen: ELSE, missing };
    if (value) return { chosen: c.name, missing: [] };
  }
  return { chosen: ELSE, missing: [] };
}

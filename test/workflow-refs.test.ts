// ABOUTME: Pure-logic tests for {{nodeId.field}} data-passing references — extraction, step-output
// ABOUTME: normalization, dotted-path resolution, and prompt interpolation (missing refs collected).
// ABOUTME: No DB, no spawn (mirrors test/workflows.test.ts). The runtime substrate is a step's stored output.

import { describe, it, expect } from 'vitest';
import { extractRefs, normalizeStepOutput, resolveRef, interpolate } from '../lib/workflow-refs';

// A stored agent step output as the walker persists it: { runId, runStatus, result: <claude result line> }.
const agentOutput = (structured: unknown, text = 'free text answer') => ({
  runId: 'r1',
  runStatus: 'completed',
  result: { type: 'result', result: text, structured_output: structured, total_cost_usd: 0 },
});

describe('workflow-refs — extractRefs', () => {
  it('pulls {{nodeId.path}} tokens with node id and dotted path', () => {
    const refs = extractRefs('Summarize {{research.result}} then use {{research.output.topic}} once.');
    expect(refs.map((r) => `${r.nodeId}.${r.path}`)).toEqual(['research.result', 'research.output.topic']);
    expect(refs[0].raw).toBe('{{research.result}}');
  });

  it('tolerates inner whitespace and dashed/underscored node ids', () => {
    const refs = extractRefs('{{ node-1.output.a }} and {{node_2.status}}');
    expect(refs.map((r) => r.nodeId)).toEqual(['node-1', 'node_2']);
    expect(refs.map((r) => r.path)).toEqual(['output.a', 'status']);
  });

  it('ignores literal angle brackets and single braces', () => {
    expect(extractRefs('<a.result> and {a.result} and plain text')).toEqual([]);
  });
});

describe('workflow-refs — normalizeStepOutput', () => {
  it('projects an agent step into { result, output, status }', () => {
    const v = normalizeStepOutput(agentOutput({ topic: 'otters' }, 'the answer'));
    expect(v.result).toBe('the answer');
    expect(v.output).toEqual({ topic: 'otters' });
    expect(v.status).toBe('completed');
  });

  it('yields null result/output when the run produced no result line (stub / exec)', () => {
    const v = normalizeStepOutput({ runId: 'r', runStatus: 'completed', result: null });
    expect(v.result).toBeNull();
    expect(v.output).toBeNull();
    expect(v.status).toBe('completed');
  });

  it('is defensive against an arbitrary/empty stored shape', () => {
    const v = normalizeStepOutput({ trigger: 'manual' });
    expect(v.result).toBeNull();
    expect(v.output).toBeNull();
    expect(v.status).toBeNull();
  });
});

describe('workflow-refs — resolveRef', () => {
  const view = normalizeStepOutput(agentOutput({ topic: 'otters', nested: { n: 3 } }, 'hello'));

  it('resolves the result root', () => {
    expect(resolveRef(view, 'result')).toEqual({ found: true, value: 'hello' });
  });

  it('resolves the structured-output object and dotted paths into it', () => {
    expect(resolveRef(view, 'output')).toEqual({ found: true, value: { topic: 'otters', nested: { n: 3 } } });
    expect(resolveRef(view, 'output.topic')).toEqual({ found: true, value: 'otters' });
    expect(resolveRef(view, 'output.nested.n')).toEqual({ found: true, value: 3 });
  });

  it('resolves status', () => {
    expect(resolveRef(view, 'status')).toEqual({ found: true, value: 'completed' });
  });

  it('reports not-found for unknown roots, missing keys, and null values', () => {
    expect(resolveRef(view, 'nope').found).toBe(false);
    expect(resolveRef(view, 'output.missing').found).toBe(false);
    const empty = normalizeStepOutput({ runId: 'r', runStatus: 'completed', result: null });
    expect(resolveRef(empty, 'output').found).toBe(false); // null structured output = missing
    expect(resolveRef(empty, 'result').found).toBe(false);
  });
});

describe('workflow-refs — interpolate', () => {
  const views = new Map([
    ['research', normalizeStepOutput(agentOutput({ topic: 'otters' }, 'sea otters hold hands'))],
  ]);

  it('substitutes resolved refs into the prompt text', () => {
    const { text, missing } = interpolate('Topic is {{research.output.topic}}: {{research.result}}', views);
    expect(text).toBe('Topic is otters: sea otters hold hands');
    expect(missing).toEqual([]);
  });

  it('JSON-stringifies object/scalar values spliced into text', () => {
    const { text } = interpolate('Full: {{research.output}}', views);
    expect(text).toBe('Full: {"topic":"otters"}');
  });

  it('collects missing refs (unknown node or unresolved path) and leaves the token in place', () => {
    const { text, missing } = interpolate('{{ghost.result}} and {{research.output.nope}}', views);
    expect(missing).toEqual(['{{ghost.result}}', '{{research.output.nope}}']);
    expect(text).toContain('{{ghost.result}}'); // untouched — the caller hard-fails on missing
  });

  it('returns the text unchanged and no missing when there are no refs', () => {
    const { text, missing } = interpolate('a static prompt', views);
    expect(text).toBe('a static prompt');
    expect(missing).toEqual([]);
  });
});

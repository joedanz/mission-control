// ABOUTME: Pure-logic tests for the workflow graph helpers — node lookup, DAG/cycle detection, topo
// ABOUTME: order, graph validation, and agent-node config reads. No DB, no spawn (mirrors render-profile).

import { describe, it, expect } from 'vitest';
import {
  nodeById, outgoers, incomers, triggerNodes, entryNode,
  hasCycle, topoOrder, validateGraph, readAgentNodeData, assertWorkflowStatus,
} from '../lib/workflows';
import type { WorkflowGraph, WorkflowNode } from '../lib/db/schema';
import { ValidationError } from '../lib/validation';

const trigger = (id = 't'): WorkflowNode => ({ id, type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } });
const agent = (id = 'a', prompt = 'do the thing'): WorkflowNode => ({ id, type: 'agent', position: { x: 0, y: 0 }, data: { prompt } });
const edge = (id: string, source: string, target: string) => ({ id, source, target });
const G = (nodes: WorkflowNode[], edges = [] as ReturnType<typeof edge>[]): WorkflowGraph => ({ nodes, edges });

// A valid slice-1 graph: manual trigger → agent.
const linear = () => G([trigger('t'), agent('a')], [edge('e1', 't', 'a')]);

describe('workflows — graph traversal', () => {
  it('nodeById finds a node or returns undefined', () => {
    const g = linear();
    expect(nodeById(g, 'a')?.type).toBe('agent');
    expect(nodeById(g, 'missing')).toBeUndefined();
  });

  it('outgoers / incomers follow edges', () => {
    const g = linear();
    expect(outgoers(g, 't').map((n) => n.id)).toEqual(['a']);
    expect(incomers(g, 'a').map((n) => n.id)).toEqual(['t']);
    expect(outgoers(g, 'a')).toEqual([]);
  });

  it('triggerNodes + entryNode return the trigger', () => {
    const g = linear();
    expect(triggerNodes(g).map((n) => n.id)).toEqual(['t']);
    expect(entryNode(g).id).toBe('t');
  });
});

describe('workflows — DAG / topo order', () => {
  it('hasCycle is false for a DAG and true for a cycle', () => {
    expect(hasCycle(linear())).toBe(false);
    const cyclic = G([agent('a'), agent('b')], [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')]);
    expect(hasCycle(cyclic)).toBe(true);
  });

  it('topoOrder returns a parent-before-child order', () => {
    const g = G([trigger('t'), agent('a'), agent('b')], [edge('e1', 't', 'a'), edge('e2', 'a', 'b')]);
    expect(topoOrder(g)).toEqual(['t', 'a', 'b']);
  });

  it('topoOrder throws on a cycle', () => {
    const cyclic = G([agent('a'), agent('b')], [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')]);
    expect(() => topoOrder(cyclic)).toThrow(ValidationError);
  });
});

describe('workflows — validateGraph', () => {
  it('accepts a manual → agent graph', () => {
    expect(() => validateGraph(linear())).not.toThrow();
  });

  it('rejects an empty graph', () => {
    expect(() => validateGraph(G([]))).toThrow(ValidationError);
  });

  it('rejects duplicate node ids', () => {
    expect(() => validateGraph(G([trigger('t'), agent('t')], []))).toThrow(/duplicate/i);
  });

  it('rejects an unknown node type', () => {
    const bad = G([{ id: 'x', type: 'frobnicate' as never, position: { x: 0, y: 0 }, data: {} }]);
    expect(() => validateGraph(bad)).toThrow(ValidationError);
  });

  it('rejects a dangling edge', () => {
    expect(() => validateGraph(G([trigger('t'), agent('a')], [edge('e1', 't', 'ghost')]))).toThrow(/edge/i);
  });

  it('rejects a cycle', () => {
    const cyclic = G([trigger('t'), agent('a'), agent('b')], [edge('e1', 't', 'a'), edge('e2', 'a', 'b'), edge('e3', 'b', 'a')]);
    expect(() => validateGraph(cyclic)).toThrow(/cycle/i);
  });

  it('requires exactly one trigger node', () => {
    expect(() => validateGraph(G([agent('a')]))).toThrow(/trigger/i);
    expect(() => validateGraph(G([trigger('t1'), trigger('t2'), agent('a')], [edge('e1', 't1', 'a')]))).toThrow(/trigger/i);
  });

  it('rejects an agent node with no prompt', () => {
    const bad = G([trigger('t'), { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: {} }], [edge('e1', 't', 'a')]);
    expect(() => validateGraph(bad)).toThrow(/prompt/i);
  });
});

describe('workflows — readAgentNodeData', () => {
  it('returns the typed agent config', () => {
    const node: WorkflowNode = { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { prompt: 'go', profileSlug: 'researcher', projectSlug: 'acme' } };
    const d = readAgentNodeData(node);
    expect(d.prompt).toBe('go');
    expect(d.profileSlug).toBe('researcher');
    expect(d.projectSlug).toBe('acme');
  });

  it('throws when the prompt is missing or blank', () => {
    expect(() => readAgentNodeData({ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: {} })).toThrow(ValidationError);
    expect(() => readAgentNodeData({ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { prompt: '   ' } })).toThrow(/prompt/i);
  });
});

describe('workflows — enum guards', () => {
  it('assertWorkflowStatus narrows valid values and throws otherwise', () => {
    expect(assertWorkflowStatus('active')).toBe('active');
    expect(() => assertWorkflowStatus('bogus')).toThrow(ValidationError);
  });
});

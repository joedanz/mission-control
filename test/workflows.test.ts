// ABOUTME: Pure-logic tests for the workflow graph helpers — node lookup, DAG/cycle detection, topo
// ABOUTME: order, graph validation, and agent-node config reads. No DB, no spawn (mirrors render-profile).

import { describe, it, expect } from 'vitest';
import {
  nodeById, outgoers, incomers, triggerNodes, entryNode, ancestors,
  hasCycle, topoOrder, decidableNodes, canConnect, validateGraph, readAgentNodeData, readIntegrationNodeData, readBranchNodeData, readTriggerNodeData, readGateNodeData, triggerSchedule, triggerEvent, assertWorkflowStatus,
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

describe('workflows — decidableNodes (concurrent scheduling)', () => {
  // t → {a, b, c} → m: a fan-out (3 parallel branches) that re-joins at a merge node m.
  const diamond = () => G(
    [trigger('t'), agent('a'), agent('b'), agent('c'), agent('m')],
    [edge('e1', 't', 'a'), edge('e2', 't', 'b'), edge('e3', 't', 'c'), edge('e4', 'a', 'm'), edge('e5', 'b', 'm'), edge('e6', 'c', 'm')],
  );

  it('starts with only the trigger (no predecessors)', () => {
    expect(decidableNodes(diamond(), new Set(), new Set())).toEqual(['t']);
  });

  it('fans out to ALL branches once the trigger is terminal', () => {
    expect(decidableNodes(diamond(), new Set(['t']), new Set(['t']))).toEqual(['a', 'b', 'c']);
  });

  it('does NOT decide the merge until every branch is terminal (wait-all)', () => {
    const started = new Set(['t', 'a', 'b', 'c']);
    expect(decidableNodes(diamond(), new Set(['t', 'a', 'b']), started)).toEqual([]); // c still in-flight
    expect(decidableNodes(diamond(), new Set(['t', 'a', 'b', 'c']), started)).toEqual(['m']); // all branches done
  });

  it('treats a skipped branch as resolved (a not-taken path never deadlocks the join)', () => {
    // c was skipped (terminal) — m still becomes decidable once a, b, c are all terminal.
    const started = new Set(['t', 'a', 'b', 'c']);
    expect(decidableNodes(diamond(), new Set(['t', 'a', 'b', 'c']), started)).toEqual(['m']);
  });

  it('excludes already-started nodes (never launches twice)', () => {
    const started = new Set(['t', 'a', 'b', 'c', 'm']);
    expect(decidableNodes(diamond(), new Set(['t', 'a', 'b', 'c']), started)).toEqual([]);
  });
});

describe('workflows — canConnect (slice 9b draw-time edge SSOT)', () => {
  // t → a already wired; b is a second free agent.
  const base = () => G([trigger('t'), agent('a'), agent('b')], [edge('e1', 't', 'a')]);

  it('accepts a valid new edge between existing nodes', () => {
    expect(canConnect(base(), 'a', 'b')).toBe(true);
  });

  it('rejects a self-loop', () => {
    expect(canConnect(base(), 'a', 'a')).toBe(false);
  });

  it('rejects an edge whose endpoint does not exist', () => {
    expect(canConnect(base(), 'a', 'missing')).toBe(false);
    expect(canConnect(base(), 'missing', 'a')).toBe(false);
  });

  it('rejects an edge INTO a trigger (triggers have no inputs)', () => {
    expect(canConnect(base(), 'a', 't')).toBe(false);
  });

  it('rejects an edge that would create a cycle', () => {
    // t → a → b already; adding b → a closes a cycle.
    const g = G([trigger('t'), agent('a'), agent('b')], [edge('e1', 't', 'a'), edge('e2', 'a', 'b')]);
    expect(canConnect(g, 'b', 'a')).toBe(false);
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

  it('rejects an edge that targets the trigger (the same rule canConnect enforces at draw time)', () => {
    const bad = G([trigger('t'), agent('a')], [edge('e1', 't', 'a'), edge('e2', 'a', 't')]);
    expect(() => validateGraph(bad)).toThrow(/no inputs/i);
  });
});

describe('workflows — ancestors', () => {
  it('returns every node with a directed path into the target', () => {
    const g = G([trigger('t'), agent('a'), agent('b')], [edge('e1', 't', 'a'), edge('e2', 'a', 'b')]);
    expect([...ancestors(g, 'b')].sort()).toEqual(['a', 't']);
    expect([...ancestors(g, 'a')]).toEqual(['t']);
    expect([...ancestors(g, 't')]).toEqual([]);
  });

  it('does not count an unconnected earlier node as an ancestor', () => {
    // c is a second trigger-less branch with no edge into b — topologically earlier but NOT an ancestor.
    const g = G([trigger('t'), agent('a'), agent('c')], [edge('e1', 't', 'a')]);
    expect(ancestors(g, 'a').has('c')).toBe(false);
  });
});

describe('workflows — readAgentNodeData', () => {
  it('returns the typed agent config', () => {
    const node: WorkflowNode = { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { prompt: 'go', profileSlug: 'researcher', projectSlug: 'acme', onError: 'continue' } };
    const d = readAgentNodeData(node);
    expect(d.prompt).toBe('go');
    expect(d.profileSlug).toBe('researcher');
    expect(d.projectSlug).toBe('acme');
    expect(d.onError).toBe('continue');
  });

  it('throws when the prompt is missing or blank', () => {
    expect(() => readAgentNodeData({ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: {} })).toThrow(ValidationError);
    expect(() => readAgentNodeData({ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { prompt: '   ' } })).toThrow(/prompt/i);
  });

  it('rejects an invalid onError value', () => {
    expect(() => readAgentNodeData({ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { prompt: 'go', onError: 'explode' } })).toThrow(ValidationError);
  });
});

describe('workflows — validateGraph data-passing refs', () => {
  // t → a → b: b may reference a (an ancestor).
  const chain = (bPrompt: string) =>
    G([trigger('t'), agent('a'), { id: 'b', type: 'agent', position: { x: 0, y: 0 }, data: { prompt: bPrompt } }],
      [edge('e1', 't', 'a'), edge('e2', 'a', 'b')]);

  it('accepts a reference to an ancestor node', () => {
    expect(() => validateGraph(chain('use {{a.output.topic}} and {{a.result}}'))).not.toThrow();
  });

  it('rejects a reference to a non-ancestor node', () => {
    // d exists but has no path into b — referencing it is not edge-backed.
    const g = G(
      [trigger('t'), agent('a'), agent('d'), { id: 'b', type: 'agent', position: { x: 0, y: 0 }, data: { prompt: 'use {{d.result}}' } }],
      [edge('e1', 't', 'a'), edge('e2', 'a', 'b')],
    );
    expect(() => validateGraph(g)).toThrow(/ancestor|edge|reference/i);
  });

  it('rejects a reference to a nonexistent node', () => {
    expect(() => validateGraph(chain('use {{ghost.result}}'))).toThrow(ValidationError);
  });

  it('rejects a self-reference', () => {
    const g = G([trigger('t'), { id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { prompt: 'use {{a.result}}' } }], [edge('e1', 't', 'a')]);
    expect(() => validateGraph(g)).toThrow(ValidationError);
  });
});

const integration = (id: string, data: Record<string, unknown>): WorkflowNode => ({ id, type: 'integration', position: { x: 0, y: 0 }, data });

describe('workflows — readIntegrationNodeData', () => {
  it('returns the typed integration config', () => {
    const d = readIntegrationNodeData(integration('i', { toolkit: 'linear', action: 'LINEAR_CREATE_LINEAR_ISSUE', arguments: { title: 'x' }, onError: 'continue' }));
    expect(d.toolkit).toBe('linear');
    expect(d.action).toBe('LINEAR_CREATE_LINEAR_ISSUE');
    expect(d.arguments).toEqual({ title: 'x' });
    expect(d.onError).toBe('continue');
  });

  it('rejects an unknown toolkit (lists the supported ones)', () => {
    expect(() => readIntegrationNodeData(integration('i', { toolkit: 'jira', action: 'X' }))).toThrow(/toolkit|linear|slack/i);
  });

  it('rejects an action not in the toolkit allow-list', () => {
    expect(() => readIntegrationNodeData(integration('i', { toolkit: 'linear', action: 'LINEAR_DELETE_EVERYTHING' }))).toThrow(/action|allow/i);
  });

  it('rejects a missing toolkit/action and a bad onError', () => {
    expect(() => readIntegrationNodeData(integration('i', { action: 'LINEAR_CREATE_LINEAR_ISSUE' }))).toThrow(ValidationError);
    expect(() => readIntegrationNodeData(integration('i', { toolkit: 'linear' }))).toThrow(ValidationError);
    expect(() => readIntegrationNodeData(integration('i', { toolkit: 'linear', action: 'LINEAR_CREATE_LINEAR_ISSUE', onError: 'explode' }))).toThrow(ValidationError);
  });
});

describe('workflows — validateGraph integration nodes', () => {
  // t → i: a valid Composio action node.
  const withIntegration = (data: Record<string, unknown>) =>
    G([trigger('t'), integration('i', data)], [edge('e1', 't', 'i')]);

  it('accepts a valid integration node', () => {
    expect(() => validateGraph(withIntegration({ toolkit: 'linear', action: 'LINEAR_LIST_LINEAR_TEAMS' }))).not.toThrow();
  });

  it('rejects an unknown toolkit / disallowed action', () => {
    expect(() => validateGraph(withIntegration({ toolkit: 'jira', action: 'X' }))).toThrow(ValidationError);
    expect(() => validateGraph(withIntegration({ toolkit: 'slack', action: 'SLACK_NUKE' }))).toThrow(ValidationError);
  });

  it('accepts an arg {{ref}} to an ancestor and rejects one to a non-ancestor', () => {
    // t → a → i: i may reference a (ancestor) in its arguments.
    const ok = G(
      [trigger('t'), agent('a'), integration('i', { toolkit: 'slack', action: 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL', arguments: { text: 'topic: {{a.output.topic}}' } })],
      [edge('e1', 't', 'a'), edge('e2', 'a', 'i')],
    );
    expect(() => validateGraph(ok)).not.toThrow();

    // d has no edge into i — referencing it from an arg is not edge-backed.
    const bad = G(
      [trigger('t'), agent('a'), agent('d'), integration('i', { toolkit: 'slack', action: 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL', arguments: { text: '{{d.result}}' } })],
      [edge('e1', 't', 'a'), edge('e2', 'a', 'i')],
    );
    expect(() => validateGraph(bad)).toThrow(/ancestor|edge|reference|unknown/i);
  });
});

const branch = (id: string, data: Record<string, unknown>): WorkflowNode => ({ id, type: 'branch', position: { x: 0, y: 0 }, data });
const oneCase = (overrides: Record<string, unknown> = {}) => ({
  cases: [{ name: 'high', when: { left: '{{a.output.score}}', op: 'gte', right: 80 } }],
  ...overrides,
});

describe('workflows — readBranchNodeData', () => {
  it('returns the typed branch config (cases + onError)', () => {
    const d = readBranchNodeData(branch('b', oneCase({ onError: 'continue' })));
    expect(d.cases).toHaveLength(1);
    expect(d.cases[0]).toEqual({ name: 'high', when: { left: '{{a.output.score}}', op: 'gte', right: 80 } });
    expect(d.onError).toBe('continue');
  });

  it('rejects no cases, a blank/duplicate/reserved name, a missing condition, and an unknown op', () => {
    expect(() => readBranchNodeData(branch('b', { cases: [] }))).toThrow(/case/i);
    expect(() => readBranchNodeData(branch('b', { cases: [{ name: '  ', when: { left: 1, op: 'eq' } }] }))).toThrow(/name/i);
    expect(() => readBranchNodeData(branch('b', { cases: [{ name: 'else', when: { left: 1, op: 'eq' } }] }))).toThrow(/else|fallback/i);
    const dup = { cases: [{ name: 'x', when: { left: 1, op: 'eq' } }, { name: 'x', when: { left: 2, op: 'eq' } }] };
    expect(() => readBranchNodeData(branch('b', dup))).toThrow(/duplicate/i);
    expect(() => readBranchNodeData(branch('b', { cases: [{ name: 'x' }] }))).toThrow(/condition/i);
    expect(() => readBranchNodeData(branch('b', { cases: [{ name: 'x', when: { left: 1, op: 'nope' } }] }))).toThrow(ValidationError);
  });
});

describe('workflows — validateGraph branch nodes', () => {
  it('accepts a branch whose condition refs an ancestor', () => {
    // t → a → b: b's condition may reference a (ancestor).
    const ok = G(
      [trigger('t'), agent('a'), branch('b', oneCase())],
      [edge('e1', 't', 'a'), edge('e2', 'a', 'b')],
    );
    expect(() => validateGraph(ok)).not.toThrow();
  });

  it('rejects a branch condition ref to a non-ancestor', () => {
    // d has no edge into b — referencing it from a condition is not edge-backed.
    const bad = G(
      [trigger('t'), agent('a'), agent('d'), branch('b', { cases: [{ name: 'x', when: { left: '{{d.result}}', op: 'truthy' } }] })],
      [edge('e1', 't', 'a'), edge('e2', 'a', 'b')],
    );
    expect(() => validateGraph(bad)).toThrow(/ancestor|edge|reference|unknown/i);
  });

  it('rejects a malformed branch (no cases) during validation', () => {
    const bad = G([trigger('t'), branch('b', { cases: [] })], [edge('e1', 't', 'b')]);
    expect(() => validateGraph(bad)).toThrow(/case/i);
  });
});

describe('workflows — readGateNodeData (slice 9a gate)', () => {
  const gate = (id: string, data: Record<string, unknown> = {}): WorkflowNode => ({ id, type: 'gate', position: { x: 0, y: 0 }, data });

  it('accepts a bare gate (no fields) and a gate with message + onError', () => {
    expect(readGateNodeData(gate('g'))).toEqual({});
    expect(readGateNodeData(gate('g', { message: 'Approve the deploy?', onError: 'continue' }))).toEqual({ message: 'Approve the deploy?', onError: 'continue' });
  });

  it('rejects a non-string message and a bad onError', () => {
    expect(() => readGateNodeData(gate('g', { message: 123 }))).toThrow(/message/i);
    expect(() => readGateNodeData(gate('g', { onError: 'explode' }))).toThrow(ValidationError);
  });

  it('validateGraph accepts a trigger → gate → agent graph and rejects a malformed gate', () => {
    const ok = G([trigger('t'), { id: 'g', type: 'gate', position: { x: 0, y: 0 }, data: { message: 'ok?' } }, agent('a')], [edge('e1', 't', 'g'), edge('e2', 'g', 'a')]);
    expect(() => validateGraph(ok)).not.toThrow();
    const bad = G([trigger('t'), { id: 'g', type: 'gate', position: { x: 0, y: 0 }, data: { onError: 'nope' } }], [edge('e1', 't', 'g')]);
    expect(() => validateGraph(bad)).toThrow(ValidationError);
  });
});

describe('workflows — readTriggerNodeData (slice 7 schedule)', () => {
  const triggerWith = (data: Record<string, unknown>): WorkflowNode => ({ id: 't', type: 'trigger', position: { x: 0, y: 0 }, data });

  it('a manual trigger (no schedule) returns an empty config', () => {
    expect(readTriggerNodeData(trigger('t'))).toEqual({});
    expect(readTriggerNodeData(triggerWith({}))).toEqual({});
  });

  it('accepts a valid cron schedule (with timezone)', () => {
    const d = readTriggerNodeData(triggerWith({ schedule: { cron: '0 9 * * *', timezone: 'America/New_York' } }));
    expect(d.schedule).toEqual({ cron: '0 9 * * *', timezone: 'America/New_York' });
  });

  it('accepts a valid interval schedule', () => {
    expect(readTriggerNodeData(triggerWith({ schedule: { intervalSec: 3600 } })).schedule).toEqual({ intervalSec: 3600 });
  });

  it('rejects both cron and intervalSec, or neither', () => {
    expect(() => readTriggerNodeData(triggerWith({ schedule: { cron: '0 9 * * *', intervalSec: 3600 } }))).toThrow(/exactly one/i);
    expect(() => readTriggerNodeData(triggerWith({ schedule: {} }))).toThrow(/exactly one/i);
  });

  it('rejects an invalid cron, a sub-floor interval, and a bad timezone', () => {
    expect(() => readTriggerNodeData(triggerWith({ schedule: { cron: 'not a cron !!' } }))).toThrow(/cron/i);
    expect(() => readTriggerNodeData(triggerWith({ schedule: { intervalSec: 30 } }))).toThrow(/intervalSec/i);
    expect(() => readTriggerNodeData(triggerWith({ schedule: { cron: '0 9 * * *', timezone: 'Mars/Phobos' } }))).toThrow(/timezone/i);
  });

  it('triggerSchedule reads the entry node schedule, or null for a manual trigger', () => {
    const scheduled = G([{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { schedule: { intervalSec: 600 } } }, agent('a')], [edge('e1', 't', 'a')]);
    expect(triggerSchedule(scheduled)).toEqual({ intervalSec: 600 });
    expect(triggerSchedule(linear())).toBeNull();
  });

  it('validateGraph rejects a workflow whose trigger schedule is malformed', () => {
    const bad = G([{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { schedule: { intervalSec: 5 } } }, agent('a')], [edge('e1', 't', 'a')]);
    expect(() => validateGraph(bad)).toThrow(/intervalSec/i);
  });
});

describe('workflows — readTriggerNodeData (slice 8 event)', () => {
  const triggerWith = (data: Record<string, unknown>): WorkflowNode => ({ id: 't', type: 'trigger', position: { x: 0, y: 0 }, data });

  it('accepts an event trigger with a source + types allowlist', () => {
    const d = readTriggerNodeData(triggerWith({ event: { source: 'github', types: ['issues', 'pull_request'] } }));
    expect(d.event).toEqual({ source: 'github', types: ['issues', 'pull_request'] });
  });

  it('accepts an empty event config (fire on any authenticated POST)', () => {
    expect(readTriggerNodeData(triggerWith({ event: {} })).event).toEqual({});
  });

  it('rejects a trigger carrying both a schedule and an event', () => {
    expect(() => readTriggerNodeData(triggerWith({ schedule: { intervalSec: 600 }, event: {} }))).toThrow(/exactly one way/i);
  });

  it('rejects a malformed event config and non-string types', () => {
    expect(() => readTriggerNodeData(triggerWith({ event: 'github' }))).toThrow(/malformed event/i);
    expect(() => readTriggerNodeData(triggerWith({ event: { types: 'issues' } }))).toThrow(/types/i);
    expect(() => readTriggerNodeData(triggerWith({ event: { types: ['issues', ''] } }))).toThrow(/types/i);
    expect(() => readTriggerNodeData(triggerWith({ event: { source: 7 } }))).toThrow(/source/i);
  });

  it('triggerEvent reads the entry node event config, or null for a non-event trigger', () => {
    const ev = G([{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { event: { types: ['issues'] } } }, agent('a')], [edge('e1', 't', 'a')]);
    expect(triggerEvent(ev)).toEqual({ types: ['issues'] });
    expect(triggerEvent(linear())).toBeNull();
  });

  it('validateGraph rejects a workflow whose trigger event is malformed', () => {
    const bad = G([{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { event: { types: [42] } } }, agent('a')], [edge('e1', 't', 'a')]);
    expect(() => validateGraph(bad)).toThrow(/types/i);
  });
});

describe('workflows — enum guards', () => {
  it('assertWorkflowStatus narrows valid values and throws otherwise', () => {
    expect(assertWorkflowStatus('active')).toBe('active');
    expect(() => assertWorkflowStatus('bogus')).toThrow(ValidationError);
  });
});

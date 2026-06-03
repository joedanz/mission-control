// ABOUTME: Unit tests for the workflow view mappers — Workflow/WorkflowRun/WorkflowStepRun rows projected
// ABOUTME: into the lean client DTOs the canvas tab consumes. Pure (no DB/network): proves node/edge counts,
// ABOUTME: Date→ISO conversion, latest-run selection, and the per-node step-status overlay map.

import { describe, it, expect } from 'vitest';
import { toRunSummary, toWorkflowListItem, toWorkflowDetail, stepStatusByNode } from '../lib/workflow-view';
import type { Workflow, WorkflowRun, WorkflowStepRun, WorkflowGraph } from '../lib/db/schema';

const GRAPH: WorkflowGraph = {
  nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
    { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'do the thing' } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
};

function wf(partial: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf1', projectId: 'p1', slug: 'triage', name: 'Issue triage', description: null,
    status: 'draft', graph: GRAPH, version: 1, createdAt: new Date(), updatedAt: new Date(),
    ...partial,
  } as Workflow;
}

function run(partial: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'r1', workflowId: 'wf1', status: 'running', trigger: 'manual', graphSnapshot: GRAPH,
    context: null, cancelRequested: false,
    startedAt: new Date('2026-06-03T10:00:00.000Z'), endedAt: null,
    lastHeartbeatAt: new Date('2026-06-03T10:00:05.000Z'),
    ...partial,
  } as WorkflowRun;
}

function step(partial: Partial<WorkflowStepRun> = {}): WorkflowStepRun {
  return {
    id: 's1', workflowRunId: 'r1', nodeId: 't', status: 'completed', runId: null,
    output: null, error: null, startedAt: null, endedAt: null, createdAt: new Date(),
    ...partial,
  } as WorkflowStepRun;
}

describe('toRunSummary', () => {
  it('projects a run, converting dates to ISO strings and a null endedAt', () => {
    const s = toRunSummary(run());
    expect(s).toEqual({
      id: 'r1', status: 'running', trigger: 'manual',
      startedAt: '2026-06-03T10:00:00.000Z', endedAt: null,
    });
  });

  it('serializes a terminal run endedAt', () => {
    const s = toRunSummary(run({ status: 'completed', endedAt: new Date('2026-06-03T10:01:00.000Z') }));
    expect(s.status).toBe('completed');
    expect(s.endedAt).toBe('2026-06-03T10:01:00.000Z');
  });
});

describe('toWorkflowListItem', () => {
  it('counts nodes and carries identity/status', () => {
    const item = toWorkflowListItem(wf({ status: 'active' }), null);
    expect(item).toMatchObject({ slug: 'triage', name: 'Issue triage', status: 'active', nodeCount: 2 });
    expect(item.latestRun).toBeNull();
  });

  it('attaches a latest-run summary when present', () => {
    const item = toWorkflowListItem(wf(), run({ status: 'completed', endedAt: new Date('2026-06-03T10:01:00.000Z') }));
    expect(item.latestRun?.id).toBe('r1');
    expect(item.latestRun?.status).toBe('completed');
  });
});

describe('stepStatusByNode', () => {
  it('maps node id → step status', () => {
    const map = stepStatusByNode([step({ nodeId: 't', status: 'completed' }), step({ id: 's2', nodeId: 'a', status: 'running' })]);
    expect(map).toEqual({ t: 'completed', a: 'running' });
  });

  it('is empty for no steps', () => {
    expect(stepStatusByNode([])).toEqual({});
  });
});

describe('toWorkflowDetail', () => {
  it('passes the graph through, takes the newest run as latest, and overlays its steps', () => {
    const runs = [
      run({ id: 'r2', status: 'running' }), // store returns desc(startedAt): newest first
      run({ id: 'r1', status: 'completed', endedAt: new Date('2026-06-03T09:00:00.000Z') }),
    ];
    const steps = [step({ nodeId: 't', status: 'completed' }), step({ id: 's2', nodeId: 'a', status: 'running' })];
    const detail = toWorkflowDetail(wf(), runs, steps);

    expect(detail.graph).toEqual(GRAPH);
    expect(detail.latestRun?.id).toBe('r2'); // first = newest
    expect(detail.stepStatus).toEqual({ t: 'completed', a: 'running' });
  });

  it('handles a workflow with no runs', () => {
    const detail = toWorkflowDetail(wf(), [], []);
    expect(detail.latestRun).toBeNull();
    expect(detail.stepStatus).toEqual({});
  });
});

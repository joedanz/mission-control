// ABOUTME: Tests for the read-only project workflows route — GET lists workflows (+latest-run summary);
// ABOUTME: GET ?workflow= returns one workflow's graph + run history + latest-run step overlay. Maps
// ABOUTME: unauthorized→401 and missing project / foreign workflow→404. CI-safe: mocks auth + store + queries.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowGraph } from '../lib/db/schema';

class FakeUnauthorized extends Error {}

const requireAllowedUser = vi.fn(async () => ({ user: { email: 'joe@ticc.net' } }));
vi.mock('@/lib/authz', () => ({
  requireAllowedUser: () => requireAllowedUser(),
  UnauthorizedError: FakeUnauthorized,
}));

const queries = { getProjectBySlug: vi.fn() };
vi.mock('@/lib/queries', () => queries);

const store = {
  listWorkflows: vi.fn(),
  getWorkflowBySlug: vi.fn(),
  getWorkflowById: vi.fn(),
  getWorkflowRun: vi.fn(),
  requeueWorkflowRun: vi.fn(),
  listWorkflowRuns: vi.fn(),
  listStepRuns: vi.fn(),
};
vi.mock('@/lib/workflow-store', () => store);

const enqueue = { enqueueWorkflowRun: vi.fn(), decideGate: vi.fn(), saveWorkflowGraph: vi.fn(), createDraftWorkflow: vi.fn() };
vi.mock('@/lib/workflow-enqueue', () => enqueue);

// Import AFTER mocks are registered. ConflictError/ValidationError are the REAL classes (validation has no DB
// deps) so the route's `instanceof … → 409/422` branches are exercised, not a mock.
const { GET, POST } = await import('../app/api/projects/[slug]/workflows/route');
const { ConflictError, ValidationError } = await import('../lib/validation');

const GRAPH: WorkflowGraph = {
  nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
    { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'hi' } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
};
const params = Promise.resolve({ slug: 'demo' });
const wfRow = (over = {}) => ({ id: 'wf1', projectId: 'p1', slug: 'triage', name: 'Triage', description: null, status: 'active', graph: GRAPH, version: 1, createdAt: new Date(), updatedAt: new Date(), ...over });
const runRow = (over = {}) => ({ id: 'r1', workflowId: 'wf1', status: 'running', trigger: 'manual', graphSnapshot: GRAPH, context: null, cancelRequested: false, startedAt: new Date('2026-06-03T10:00:00Z'), endedAt: null, lastHeartbeatAt: new Date(), ...over });
const stepRow = (over = {}) => ({ id: 's1', workflowRunId: 'r1', nodeId: 't', status: 'completed', runId: null, output: null, error: null, startedAt: null, endedAt: null, createdAt: new Date(), ...over });

function get(url: string) {
  return GET(new Request(url), { params });
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/projects/demo/workflows', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAllowedUser.mockResolvedValue({ user: { email: 'joe@ticc.net' } });
  queries.getProjectBySlug.mockResolvedValue({ id: 'p1', slug: 'demo' });
});

describe('GET list', () => {
  it('returns the project workflows with a latest-run summary', async () => {
    store.listWorkflows.mockResolvedValue([wfRow()]);
    store.listWorkflowRuns.mockResolvedValue([runRow({ status: 'completed', endedAt: new Date('2026-06-03T10:01:00Z') })]);
    const res = await get('http://localhost/api/projects/demo/workflows');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.workflows).toHaveLength(1);
    expect(json.data.workflows[0]).toMatchObject({ slug: 'triage', nodeCount: 2 });
    expect(json.data.workflows[0].latestRun.status).toBe('completed');
  });

  it('returns an empty list for a project with no workflows', async () => {
    store.listWorkflows.mockResolvedValue([]);
    const json = await (await get('http://localhost/api/projects/demo/workflows')).json();
    expect(json.data.workflows).toEqual([]);
    expect(store.listWorkflowRuns).not.toHaveBeenCalled();
  });
});

describe('GET detail (?workflow=)', () => {
  it('returns graph + runs + latest-run step overlay', async () => {
    store.getWorkflowBySlug.mockResolvedValue(wfRow());
    store.listWorkflowRuns.mockResolvedValue([runRow()]);
    store.listStepRuns.mockResolvedValue([stepRow({ nodeId: 't', status: 'completed' }), stepRow({ id: 's2', nodeId: 'a', status: 'running' })]);
    const res = await get('http://localhost/api/projects/demo/workflows?workflow=triage');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.workflow.graph.nodes).toHaveLength(2);
    expect(json.data.workflow.stepStatus).toEqual({ t: 'completed', a: 'running' });
    expect(json.data.workflow.latestRun.id).toBe('r1');
    expect(store.listStepRuns).toHaveBeenCalledWith('r1');
  });

  it('skips the step query when the workflow has no runs', async () => {
    store.getWorkflowBySlug.mockResolvedValue(wfRow());
    store.listWorkflowRuns.mockResolvedValue([]);
    const json = await (await get('http://localhost/api/projects/demo/workflows?workflow=triage')).json();
    expect(json.data.workflow.latestRun).toBeNull();
    expect(json.data.workflow.stepStatus).toEqual({});
    expect(store.listStepRuns).not.toHaveBeenCalled();
  });

  it('404s a workflow that belongs to another project (no leak)', async () => {
    store.getWorkflowBySlug.mockResolvedValue(wfRow({ projectId: 'other' }));
    const res = await get('http://localhost/api/projects/demo/workflows?workflow=triage');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
  });

  it('404s an unknown workflow slug', async () => {
    store.getWorkflowBySlug.mockResolvedValue(null);
    expect((await get('http://localhost/api/projects/demo/workflows?workflow=nope')).status).toBe(404);
  });
});

describe('POST run (enqueue)', () => {
  beforeEach(() => {
    store.getWorkflowBySlug.mockResolvedValue(wfRow()); // belongs to project p1
  });

  it('enqueues a queued run and returns its id', async () => {
    enqueue.enqueueWorkflowRun.mockResolvedValue({ id: 'r9', status: 'queued' });
    const res = await post({ workflow: 'triage', action: 'run' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data).toMatchObject({ workflowRunId: 'r9', status: 'queued' });
    expect(enqueue.enqueueWorkflowRun).toHaveBeenCalledWith('triage', { trigger: 'manual' });
  });

  it('409 when the single-flight guard rejects', async () => {
    enqueue.enqueueWorkflowRun.mockRejectedValue(new ConflictError('workflow', 'already has a run in progress'));
    const res = await post({ workflow: 'triage', action: 'run' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('conflict');
  });

  it('404s a workflow that belongs to another project (no enqueue)', async () => {
    store.getWorkflowBySlug.mockResolvedValue(wfRow({ projectId: 'other' }));
    const res = await post({ workflow: 'triage', action: 'run' });
    expect(res.status).toBe(404);
    expect(enqueue.enqueueWorkflowRun).not.toHaveBeenCalled();
  });

  it('422 on an unknown action', async () => {
    const res = await post({ workflow: 'triage', action: 'frobnicate' });
    expect(res.status).toBe(422);
    expect(enqueue.enqueueWorkflowRun).not.toHaveBeenCalled();
  });
});

describe('POST approve (gate decision)', () => {
  beforeEach(() => {
    store.getWorkflowRun.mockResolvedValue(runRow({ status: 'paused' }));
    store.getWorkflowById.mockResolvedValue(wfRow()); // owner workflow belongs to project p1
    enqueue.decideGate.mockResolvedValue(runRow({ status: 'paused' }));
    store.requeueWorkflowRun.mockResolvedValue(runRow({ status: 'queued' }));
  });

  it('records the decision and requeues the run for the daemon', async () => {
    const res = await post({ action: 'approve', runId: 'r1', nodeId: 'g', decision: 'approve' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({ workflowRunId: 'r1', status: 'queued', decision: 'approve' });
    expect(enqueue.decideGate).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1', status: 'paused' }), 'g', 'approve', undefined);
    expect(store.requeueWorkflowRun).toHaveBeenCalledWith('r1');
  });

  it('passes a reject decision + reason through to decideGate', async () => {
    await post({ action: 'approve', runId: 'r1', nodeId: 'g', decision: 'reject', reason: 'too risky' });
    expect(enqueue.decideGate).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), 'g', 'reject', 'too risky');
  });

  it('422 on a missing runId/nodeId or a bad decision', async () => {
    expect((await post({ action: 'approve', nodeId: 'g', decision: 'approve' })).status).toBe(422);
    expect((await post({ action: 'approve', runId: 'r1', nodeId: 'g', decision: 'maybe' })).status).toBe(422);
    expect(enqueue.decideGate).not.toHaveBeenCalled();
  });

  it("404s a run whose workflow belongs to another project (no leak)", async () => {
    store.getWorkflowById.mockResolvedValue(wfRow({ projectId: 'other' }));
    const res = await post({ action: 'approve', runId: 'r1', nodeId: 'g', decision: 'approve' });
    expect(res.status).toBe(404);
    expect(enqueue.decideGate).not.toHaveBeenCalled();
  });

  it('409 when the run is no longer paused (requeue lost the race)', async () => {
    store.requeueWorkflowRun.mockResolvedValue(null);
    const res = await post({ action: 'approve', runId: 'r1', nodeId: 'g', decision: 'approve' });
    expect(res.status).toBe(409);
  });

  it('maps a ConflictError from decideGate to 409', async () => {
    enqueue.decideGate.mockRejectedValue(new ConflictError('gate', 'not awaiting approval'));
    const res = await post({ action: 'approve', runId: 'r1', nodeId: 'g', decision: 'approve' });
    expect(res.status).toBe(409);
  });
});

describe('POST save (slice 9b canvas authoring)', () => {
  it('guards ownership then persists via saveWorkflowGraph, returning the bumped version', async () => {
    store.getWorkflowBySlug.mockResolvedValue(wfRow()); // belongs to project p1
    enqueue.saveWorkflowGraph.mockResolvedValue(wfRow({ version: 2 }));
    const res = await post({ action: 'save', workflow: 'triage', graph: GRAPH });
    expect(res.status).toBe(200);
    expect((await res.json()).data.workflow.version).toBe(2);
    expect(enqueue.saveWorkflowGraph).toHaveBeenCalledWith('triage', { graph: GRAPH });
  });

  it('maps a ValidationError from saveWorkflowGraph (the SSOT) to 422', async () => {
    store.getWorkflowBySlug.mockResolvedValue(wfRow());
    enqueue.saveWorkflowGraph.mockRejectedValue(new ValidationError('graph', 'the workflow graph has a cycle'));
    const res = await post({ action: 'save', workflow: 'triage', graph: GRAPH });
    expect(res.status).toBe(422);
  });

  it('422 when the graph is missing nodes/edges arrays (before any save)', async () => {
    store.getWorkflowBySlug.mockResolvedValue(wfRow());
    expect((await post({ action: 'save', workflow: 'triage' })).status).toBe(422);
    expect(enqueue.saveWorkflowGraph).not.toHaveBeenCalled();
  });

  it('404 when the workflow belongs to another project (no save attempted)', async () => {
    store.getWorkflowBySlug.mockResolvedValue(wfRow({ projectId: 'other' }));
    const res = await post({ action: 'save', workflow: 'triage', graph: GRAPH });
    expect(res.status).toBe(404);
    expect(enqueue.saveWorkflowGraph).not.toHaveBeenCalled();
  });
});

describe('POST create (slice 9c — in-UI new workflow)', () => {
  it('creates an empty draft for the project and returns its slug', async () => {
    enqueue.createDraftWorkflow.mockResolvedValue(wfRow({ slug: 'triage', name: 'Triage', status: 'draft' }));
    const res = await post({ action: 'create', name: 'Triage' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.workflow.slug).toBe('triage');
    expect(enqueue.createDraftWorkflow).toHaveBeenCalledWith('p1', 'Triage'); // project.id, name
  });

  it('422 when the name is blank (no create attempted)', async () => {
    expect((await post({ action: 'create', name: '   ' })).status).toBe(422);
    expect(enqueue.createDraftWorkflow).not.toHaveBeenCalled();
  });

  it('maps a ConflictError (slug taken) to 409', async () => {
    enqueue.createDraftWorkflow.mockRejectedValue(new ConflictError('workflow', 'slug "triage" already exists'));
    const res = await post({ action: 'create', name: 'Triage' });
    expect(res.status).toBe(409);
  });
});

describe('gating', () => {
  it('401 when the auth gate rejects', async () => {
    requireAllowedUser.mockRejectedValue(new FakeUnauthorized());
    const res = await get('http://localhost/api/projects/demo/workflows');
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
  });

  it('404 when the project does not exist', async () => {
    queries.getProjectBySlug.mockResolvedValue(null);
    expect((await get('http://localhost/api/projects/missing/workflows')).status).toBe(404);
  });
});

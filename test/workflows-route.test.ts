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
  listWorkflowRuns: vi.fn(),
  listStepRuns: vi.fn(),
};
vi.mock('@/lib/workflow-store', () => store);

const enqueue = { enqueueWorkflowRun: vi.fn() };
vi.mock('@/lib/workflow-enqueue', () => enqueue);

// Import AFTER mocks are registered. ConflictError is the REAL class (validation has no DB deps) so the
// route's `instanceof ConflictError → 409` branch is exercised, not a mock.
const { GET, POST } = await import('../app/api/projects/[slug]/workflows/route');
const { ConflictError } = await import('../lib/validation');

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

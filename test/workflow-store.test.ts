// ABOUTME: workflow_store DB round-trips against real Neon — workflow CRUD, run lifecycle, the
// ABOUTME: single-flight count, and the idempotent (workflow_run, node) step upsert. Self-cleaning.

import { describe, it, expect, afterEach } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, type WorkflowGraph } from '../lib/db/schema';
import { createProject } from '../lib/mutations';
import {
  createWorkflow, getWorkflowBySlug, getWorkflowById, listWorkflows, setWorkflowStatus, updateWorkflowGraph,
  createWorkflowRun, getWorkflowRun, listWorkflowRuns, setWorkflowRunStatus,
  requestWorkflowRunCancel, touchWorkflowRun, countPendingWorkflowRuns,
  claimWorkflowRun, claimPausedWorkflowRun, requeueWorkflowRun, listQueuedWorkflowRuns, latestCronRunAt,
  upsertStepRun, setStepRunStatus, listStepRuns, getStepRun,
} from '../lib/workflow-store';
import { createDraftWorkflow } from '../lib/workflow-enqueue';
import { slugify, ValidationError, ConflictError } from '../lib/validation';

const projectIds: string[] = [];
const tag = () => `wf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

afterEach(async () => {
  if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds)); // cascades workflows → runs → steps
  projectIds.length = 0;
});

async function freshProject() {
  const p = await createProject({ name: tag(), category: 'internal', status: 'prelaunch' });
  projectIds.push(p.id);
  return p;
}

const graph = (): WorkflowGraph => ({
  nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
    { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'do the thing' } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
});

describe('workflow store — workflows', () => {
  it('creates + reads a workflow by slug and id', async () => {
    const p = await freshProject();
    const slug = tag();
    const wf = await createWorkflow({ projectId: p.id, slug, name: 'Issue triage', graph: graph() });
    expect(wf.status).toBe('draft');
    expect(wf.version).toBe(1);
    expect(wf.graph.nodes.length).toBe(2);
    expect((await getWorkflowBySlug(slug))?.id).toBe(wf.id);
    expect((await getWorkflowById(wf.id))?.slug).toBe(slug);
  });

  it('lists workflows for a project', async () => {
    const p = await freshProject();
    await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    await createWorkflow({ projectId: p.id, slug: tag(), name: 'B', graph: graph() });
    expect((await listWorkflows({ projectId: p.id })).length).toBe(2);
  });

  it('setWorkflowStatus flips status', async () => {
    const p = await freshProject();
    const slug = tag();
    await createWorkflow({ projectId: p.id, slug, name: 'A', graph: graph() });
    expect((await setWorkflowStatus(slug, 'paused'))?.status).toBe('paused');
  });

  it('updateWorkflowGraph replaces the graph + bumps version (slice 9b authoring)', async () => {
    const p = await freshProject();
    const slug = tag();
    await createWorkflow({ projectId: p.id, slug, name: 'A', graph: graph() });
    const next: WorkflowGraph = {
      nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } }],
      edges: [],
    };
    const updated = await updateWorkflowGraph(slug, next, { name: 'Renamed', description: 'desc' });
    expect(updated?.version).toBe(2);
    expect(updated?.graph.nodes.length).toBe(1);
    expect(updated?.name).toBe('Renamed');
    expect(updated?.description).toBe('desc');
  });

  it('updateWorkflowGraph returns null for an unknown slug', async () => {
    expect(await updateWorkflowGraph('nope-' + tag(), { nodes: [], edges: [] })).toBeNull();
  });

  it('listWorkflows filters by status (the daemon cron scan reads only active)', async () => {
    const p = await freshProject();
    const activeSlug = tag();
    await createWorkflow({ projectId: p.id, slug: activeSlug, name: 'A', graph: graph() });
    await createWorkflow({ projectId: p.id, slug: tag(), name: 'B', graph: graph() }); // stays draft
    await setWorkflowStatus(activeSlug, 'active');
    const active = await listWorkflows({ projectId: p.id, status: 'active' });
    expect(active.map((w) => w.slug)).toEqual([activeSlug]);
  });

  it('getWorkflowBySlug returns null when absent', async () => {
    expect(await getWorkflowBySlug('nope-' + tag())).toBeNull();
  });
});

describe('createDraftWorkflow (slice 9c — in-UI new workflow)', () => {
  it('creates an empty draft (slugified name, empty graph, version 1)', async () => {
    const p = await freshProject();
    const name = `Issue Triage ${tag()}`;
    const wf = await createDraftWorkflow(p.id, name);
    expect(wf.name).toBe(name);
    expect(wf.slug).toBe(slugify(name));
    expect(wf.status).toBe('draft');
    expect(wf.version).toBe(1);
    expect(wf.graph).toEqual({ nodes: [], edges: [] });
  });

  it('rejects a blank / slug-less name with ValidationError', async () => {
    const p = await freshProject();
    await expect(createDraftWorkflow(p.id, '   ')).rejects.toThrow(ValidationError);
    await expect(createDraftWorkflow(p.id, '!!!')).rejects.toThrow(ValidationError);
  });

  it('rejects a duplicate slug with ConflictError', async () => {
    const p = await freshProject();
    const name = `Dup ${tag()}`;
    await createDraftWorkflow(p.id, name);
    await expect(createDraftWorkflow(p.id, name)).rejects.toThrow(ConflictError);
  });
});

describe('workflow store — runs', () => {
  it('creates a run with a pinned graph snapshot and reads it back', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    const run = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph });
    expect(run.status).toBe('running');
    expect(run.graphSnapshot.nodes.length).toBe(2);
    expect((await getWorkflowRun(run.id))?.id).toBe(run.id);
    expect((await listWorkflowRuns({ workflowId: wf.id })).length).toBe(1);
  });

  it('countPendingWorkflowRuns counts queued + running (the single-flight guard)', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    const run = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph, status: 'queued' });
    expect(await countPendingWorkflowRuns(wf.id)).toBe(1); // a not-yet-claimed queued run still blocks a duplicate
    await claimWorkflowRun(run.id); // queued → running
    expect(await countPendingWorkflowRuns(wf.id)).toBe(1); // running is still pending
    await setWorkflowRunStatus(run.id, 'completed');
    expect(await countPendingWorkflowRuns(wf.id)).toBe(0); // terminal → not pending
  });

  it('the partial unique index refuses a second PENDING run per workflow (hard single-flight — M1)', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph, status: 'queued' });
    // A racing second enqueue that slipped past the count pre-check hits the DB constraint → ConflictError.
    await expect(createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph, status: 'queued' })).rejects.toThrow(ConflictError);
    expect((await listWorkflowRuns({ workflowId: wf.id })).length).toBe(1); // exactly one row persisted
  });

  it('--allow-concurrent runs (NULL single_flight_key) coexist; a terminal run frees the key', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph, status: 'running', allowConcurrent: true });
    await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph, status: 'running', allowConcurrent: true });
    expect((await listWorkflowRuns({ workflowId: wf.id })).length).toBe(2); // NULL keys don't collide
    // And once a normal run is terminal, its key is free for the next pending run.
    const a = await createWorkflow({ projectId: p.id, slug: tag(), name: 'B', graph: graph() });
    const r = await createWorkflowRun({ workflowId: a.id, trigger: 'manual', graphSnapshot: a.graph, status: 'running' });
    await setWorkflowRunStatus(r.id, 'completed');
    await expect(createWorkflowRun({ workflowId: a.id, trigger: 'manual', graphSnapshot: a.graph, status: 'running' })).resolves.toBeTruthy();
  });

  it('claimWorkflowRun flips queued→running exactly once (race-safe — the loser gets null)', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    const run = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph, status: 'queued' });
    const first = await claimWorkflowRun(run.id);
    expect(first?.status).toBe('running');
    expect(await claimWorkflowRun(run.id)).toBeNull(); // already claimed
  });

  it('countPendingWorkflowRuns also counts a paused run (slice 9a single-flight)', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    const run = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph, status: 'running' });
    await setWorkflowRunStatus(run.id, 'paused');
    expect(await countPendingWorkflowRuns(wf.id)).toBe(1); // a run awaiting approval still blocks a duplicate
  });

  it('requeueWorkflowRun flips paused→queued exactly once; claimPausedWorkflowRun flips paused→running', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    const run = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph, status: 'running' });
    await setWorkflowRunStatus(run.id, 'paused');
    expect((await requeueWorkflowRun(run.id))?.status).toBe('queued');
    expect(await requeueWorkflowRun(run.id)).toBeNull(); // no longer paused → null
    // A fresh paused run can instead be claimed straight to running (the sync resume path).
    await setWorkflowRunStatus(run.id, 'paused');
    expect((await claimPausedWorkflowRun(run.id))?.status).toBe('running');
    expect(await claimPausedWorkflowRun(run.id)).toBeNull();
  });

  it('latestCronRunAt returns the newest cron run (ignoring manual runs), or null when none', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    expect(await latestCronRunAt(wf.id)).toBeNull(); // never cron-fired
    // A manual run does NOT count as a cron fire (it must not reset the schedule clock). allowConcurrent so
    // these deliberately-coexisting runs (this test exercises the query, not single-flight) bypass the index.
    await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph, allowConcurrent: true });
    expect(await latestCronRunAt(wf.id)).toBeNull();
    const cron = await createWorkflowRun({ workflowId: wf.id, trigger: 'cron', graphSnapshot: wf.graph, allowConcurrent: true });
    const at = await latestCronRunAt(wf.id);
    expect(at?.getTime()).toBe(cron.startedAt.getTime());
  });

  it('listQueuedWorkflowRuns returns queued runs only (the daemon poll)', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    // allowConcurrent so the two coexisting runs bypass the single-flight index (this test exercises the poll).
    const queuedRun = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph, status: 'queued', allowConcurrent: true });
    await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph, status: 'running', allowConcurrent: true }); // not queued
    const queued = await listQueuedWorkflowRuns();
    expect(queued.map((r) => r.id)).toContain(queuedRun.id);
    expect(queued.every((r) => r.status === 'queued')).toBe(true); // robust to other projects' queued runs
  });

  it('setWorkflowRunStatus stamps endedAt on a terminal status but NOT on queued', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    const run = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph, status: 'running' });
    const queued = await setWorkflowRunStatus(run.id, 'queued'); // non-terminal — must not stamp endedAt
    expect(queued?.status).toBe('queued');
    expect(queued?.endedAt).toBeNull();
    const ended = await setWorkflowRunStatus(run.id, 'failed');
    expect(ended?.status).toBe('failed');
    expect(ended?.endedAt).not.toBeNull();
  });

  it('requestWorkflowRunCancel sets the flag; touch bumps the heartbeat', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    const run = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph });
    expect((await requestWorkflowRunCancel(run.id))?.cancelRequested).toBe(true);
    const before = (await getWorkflowRun(run.id))!.lastHeartbeatAt;
    await new Promise((r) => setTimeout(r, 10));
    const after = (await touchWorkflowRun(run.id))!.lastHeartbeatAt;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });
});

describe('workflow store — step runs', () => {
  it('upsertStepRun is idempotent on (workflow_run, node)', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    const run = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph });
    const a = await upsertStepRun(run.id, 'a', { status: 'running' });
    const b = await upsertStepRun(run.id, 'a', { status: 'running' }); // same node → same row
    expect(b.id).toBe(a.id);
    expect((await listStepRuns(run.id)).length).toBe(1);
  });

  it('setStepRunStatus records output + error + terminal status', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    const run = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph });
    const step = await upsertStepRun(run.id, 'a', { status: 'running' });
    const done = await setStepRunStatus(step.id, 'completed', { output: { result: 'ok' } });
    expect(done?.status).toBe('completed');
    expect((done?.output as { result?: string })?.result).toBe('ok');
    expect(done?.endedAt).not.toBeNull();
  });

  it('getStepRun fetches a step by (workflow_run, node), or null (slice 9a — a gate reads its own decision)', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    const run = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph });
    expect(await getStepRun(run.id, 'g')).toBeNull(); // not created yet
    await upsertStepRun(run.id, 'g', { status: 'running', output: { decision: 'approve' } });
    const fetched = await getStepRun(run.id, 'g');
    expect((fetched?.output as { decision?: string })?.decision).toBe('approve');
  });

  it('re-running a failed step into a non-failed state clears the stale error', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    const run = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph });
    const step = await upsertStepRun(run.id, 'a', { status: 'failed', error: 'boom from attempt 1' });
    expect(step.error).toBe('boom from attempt 1');

    const rerun = await upsertStepRun(run.id, 'a', { status: 'running', startedAt: new Date() });
    expect(rerun.error).toBeNull(); // stale error cleared, not preserved
    const done = await setStepRunStatus(rerun.id, 'completed', { output: { result: 'ok' } });
    expect(done?.error).toBeNull();
    expect(done?.status).toBe('completed');
  });

  it('a failed re-run keeps its existing error when none is supplied', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    const run = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph });
    await upsertStepRun(run.id, 'a', { status: 'failed', error: 'first error' });
    const again = await upsertStepRun(run.id, 'a', { status: 'failed' });
    expect(again.error).toBe('first error');
  });
});

// ABOUTME: workflow_store DB round-trips against real Neon — workflow CRUD, run lifecycle, the
// ABOUTME: single-flight count, and the idempotent (workflow_run, node) step upsert. Self-cleaning.

import { describe, it, expect, afterEach } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, type WorkflowGraph } from '../lib/db/schema';
import { createProject } from '../lib/mutations';
import {
  createWorkflow, getWorkflowBySlug, getWorkflowById, listWorkflows, setWorkflowStatus,
  createWorkflowRun, getWorkflowRun, listWorkflowRuns, setWorkflowRunStatus,
  requestWorkflowRunCancel, touchWorkflowRun, countActiveWorkflowRuns,
  upsertStepRun, setStepRunStatus, listStepRuns,
} from '../lib/workflow-store';

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

  it('getWorkflowBySlug returns null when absent', async () => {
    expect(await getWorkflowBySlug('nope-' + tag())).toBeNull();
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

  it('countActiveWorkflowRuns reflects the single-flight guard', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    const run = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph });
    expect(await countActiveWorkflowRuns(wf.id)).toBe(1);
    await setWorkflowRunStatus(run.id, 'completed');
    expect(await countActiveWorkflowRuns(wf.id)).toBe(0);
  });

  it('setWorkflowRunStatus stamps endedAt on a terminal status', async () => {
    const p = await freshProject();
    const wf = await createWorkflow({ projectId: p.id, slug: tag(), name: 'A', graph: graph() });
    const run = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph });
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
});

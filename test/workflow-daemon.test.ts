// ABOUTME: Slice-4 async execution — proves the workflow-daemon drains QUEUED runs end-to-end and the reaper
// ABOUTME: reconciles a dead walker. The daemon runs as a real `tsx daemon/workflow-daemon.ts --once` subprocess
// ABOUTME: with a STUB executor (MC_DAEMON_EXEC) so the full claim→walk→spawn→step path runs at $0. Real Neon.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, runs, events, workflowRuns, type WorkflowGraph } from '../lib/db/schema';
import { createProject } from '../lib/mutations';
import { reapStaleWorkflowRuns } from '../lib/mutations';
import { enqueueWorkflowRun } from '../lib/workflow-enqueue';
import { createWorkflow, createWorkflowRun, getWorkflowRun, listWorkflowRuns, setWorkflowStatus } from '../lib/workflow-store';

const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');

/** Run the workflow-daemon for a single tick (claims all queued runs, walks them, drains, exits). The stub
 *  executor stands in for `claude` so each agent node "runs" at $0. */
function runDaemonOnce(exec: string): void {
  execFileSync(tsxBin, ['daemon/workflow-daemon.ts', '--once'], {
    env: { ...process.env, MC_DAEMON_EXEC: exec, MC_ALLOW_DATABASE_URL_FALLBACK: '1', INGEST_TOKEN: '' },
    encoding: 'utf8',
    timeout: 55000,
  });
}

const graph = (): WorkflowGraph => ({
  nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
    { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'do the thing' } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
});

// Same shape, but the trigger carries an interval schedule (slice 7) — the workflow-daemon enqueues a cron run
// when it's due. Interval mode keeps the test deterministic (cron's minute resolution is awkward to time).
const scheduledGraph = (intervalSec = 60): WorkflowGraph => ({
  nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { schedule: { intervalSec } } },
    { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'do the thing' } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
});

describe('workflow daemon — drains queued runs', () => {
  let projectId: string;
  let repoPath: string;
  const abandonedKeys: string[] = []; // workflow.abandoned events have no projectId → clean them up by key

  beforeEach(async () => {
    repoPath = mkdtempSync(join(tmpdir(), 'wf-daemon-'));
    const p = await createProject({
      name: `vitest-wfd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      category: 'internal',
      status: 'prelaunch',
      repoPath,
    });
    projectId = p.id;
  });

  afterEach(async () => {
    for (const k of abandonedKeys.splice(0)) await db.delete(events).where(eq(events.idempotencyKey, k));
    await db.delete(events).where(eq(events.projectId, projectId));
    await db.delete(runs).where(eq(runs.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId)); // cascades workflows → workflow_runs → step_runs
    rmSync(repoPath, { recursive: true, force: true });
  });

  it(
    'claims two queued runs (distinct workflows) and walks both to completed',
    async () => {
      const slugA = `vt-wfd-a-${Date.now()}`;
      const slugB = `vt-wfd-b-${Date.now()}`;
      await createWorkflow({ projectId, slug: slugA, name: slugA, graph: graph() });
      await createWorkflow({ projectId, slug: slugB, name: slugB, graph: graph() });

      // Enqueue one run per workflow (single-flight is per-workflow, so two workflows = two queued runs).
      const runA = await enqueueWorkflowRun(slugA, { trigger: 'manual' });
      const runB = await enqueueWorkflowRun(slugB, { trigger: 'manual' });
      expect(runA.status).toBe('queued');
      expect(runB.status).toBe('queued');

      runDaemonOnce('true'); // stub agent: exit 0 → the agent node completes

      expect((await getWorkflowRun(runA.id))?.status).toBe('completed');
      expect((await getWorkflowRun(runB.id))?.status).toBe('completed');
    },
    60000,
  );

  it(
    'cron scan enqueues + walks a due active workflow to completed (and leaves a not-due one alone)',
    async () => {
      // DUE: active, interval 60, with a prior cron run backdated 2 min (anchor) → due now.
      const dueSlug = `vt-wfd-cron-due-${Date.now()}`;
      const dueWf = await createWorkflow({ projectId, slug: dueSlug, name: dueSlug, graph: scheduledGraph(60) });
      await setWorkflowStatus(dueSlug, 'active');
      const seed = await createWorkflowRun({ workflowId: dueWf.id, trigger: 'cron', graphSnapshot: dueWf.graph, status: 'completed' });
      await db.update(workflowRuns).set({ startedAt: new Date(Date.now() - 120_000) }).where(eq(workflowRuns.id, seed.id));

      // NOT DUE: active, interval 60, with a prior cron run at ~now → not due for another minute.
      const freshSlug = `vt-wfd-cron-fresh-${Date.now()}`;
      const freshWf = await createWorkflow({ projectId, slug: freshSlug, name: freshSlug, graph: scheduledGraph(60) });
      await setWorkflowStatus(freshSlug, 'active');
      await createWorkflowRun({ workflowId: freshWf.id, trigger: 'cron', graphSnapshot: freshWf.graph, status: 'completed' });

      // DRAFT: scheduled but not active → never scanned.
      const draftSlug = `vt-wfd-cron-draft-${Date.now()}`;
      const draftWf = await createWorkflow({ projectId, slug: draftSlug, name: draftSlug, graph: scheduledGraph(60) });

      runDaemonOnce('true');

      // The due workflow fired: a NEW cron run (distinct from the backdated seed) walked to completed.
      const dueRuns = await listWorkflowRuns({ workflowId: dueWf.id });
      const fired = dueRuns.filter((r) => r.id !== seed.id);
      expect(fired.length).toBe(1);
      expect(fired[0].trigger).toBe('cron');
      expect(fired[0].status).toBe('completed');

      // The not-due workflow stayed at its single seeded run; the draft never fired.
      expect((await listWorkflowRuns({ workflowId: freshWf.id })).length).toBe(1);
      expect((await listWorkflowRuns({ workflowId: draftWf.id })).length).toBe(0);
    },
    60000,
  );

  it('cron single-flight: a due workflow with a run already in flight is not double-enqueued', async () => {
    // Active, due (a running cron run backdated 2 min is the anchor AND a pending run), so the scan finds it due
    // but enqueueWorkflowRun's single-flight guard refuses a second run → exactly one run remains.
    const slug = `vt-wfd-cron-sf-${Date.now()}`;
    const wf = await createWorkflow({ projectId, slug, name: slug, graph: scheduledGraph(60) });
    await setWorkflowStatus(slug, 'active');
    const inflight = await createWorkflowRun({ workflowId: wf.id, trigger: 'cron', graphSnapshot: wf.graph, status: 'running' });
    await db.update(workflowRuns).set({ startedAt: new Date(Date.now() - 120_000), lastHeartbeatAt: new Date() }).where(eq(workflowRuns.id, inflight.id));

    runDaemonOnce('true');

    const runs = await listWorkflowRuns({ workflowId: wf.id });
    expect(runs.length).toBe(1); // the in-flight run blocked a duplicate cron fire
    expect(runs[0].id).toBe(inflight.id);
  });

  it('reaper fails a stale running workflow run and emits workflow.abandoned', async () => {
    const slug = `vt-wfd-stale-${Date.now()}`;
    const wf = await createWorkflow({ projectId, slug, name: slug, graph: graph() });
    const run = await createWorkflowRun({ workflowId: wf.id, trigger: 'manual', graphSnapshot: wf.graph, status: 'running' });
    abandonedKeys.push(`workflow.abandoned:${run.id}`);

    // Backdate the heartbeat well past the stale window (a dead walker) so the reaper reconciles it.
    await db.update(workflowRuns).set({ lastHeartbeatAt: new Date('2000-01-01T00:00:00Z') }).where(eq(workflowRuns.id, run.id));

    const reaped = await reapStaleWorkflowRuns();
    expect(reaped.map((r) => r.id)).toContain(run.id);
    expect((await getWorkflowRun(run.id))?.status).toBe('failed');

    const evt = await db.select().from(events).where(eq(events.idempotencyKey, `workflow.abandoned:${run.id}`));
    expect(evt.length).toBe(1);
    expect(evt[0].type).toBe('workflow.abandoned');
  });
});

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
import { createWorkflow, createWorkflowRun, getWorkflowRun } from '../lib/workflow-store';

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

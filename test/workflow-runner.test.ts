// ABOUTME: End-to-end test for `mc workflow run` with a STUB executor (MC_DAEMON_EXEC) so the full
// ABOUTME: validate → workflow_run → spawn → run start/end → step capture path runs without a real `claude`.
// ABOUTME: Proves RUN-ONLY visibility: an agent node opens a runs row and links it on the step, and NO
// ABOUTME: claimable task is created (so the auto-claim daemon can't race it). Real Neon DB.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, runs, events, type WorkflowGraph } from '../lib/db/schema';
import { createProject } from '../lib/mutations';
import { getNextClaimableTask } from '../lib/queries';
import { createWorkflow, getWorkflowRun, listStepRuns } from '../lib/workflow-store';

const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');

/** Invoke the worktree CLI as a subprocess (the real `mc workflow run` path). `exec` becomes the stub
 *  executor's command (run in the project's repoPath); returns the parsed JSON envelope from stdout. */
function runWorkflowCli(slug: string, exec: string): { ok: boolean; data?: { status: string; workflowRunId: string; steps: { nodeId: string; status: string; runId: string | null }[] }; error?: { code: string } } {
  // mc exits non-zero on error codes (NOT_FOUND=3 etc.) — execFileSync throws but still carries stdout (the
  // JSON envelope). Capture stdout either way; surface stderr only when stdout has no parseable envelope.
  let out: string;
  try {
    out = execFileSync(tsxBin, ['cli/index.ts', 'workflow', 'run', slug, '--json'], {
      env: { ...process.env, MC_DAEMON_EXEC: exec, MC_ALLOW_DATABASE_URL_FALLBACK: '1', INGEST_TOKEN: '' },
      encoding: 'utf8',
      timeout: 55000,
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    out = err.stdout ?? '';
    if (!out.trim()) throw new Error(`mc workflow run produced no envelope. stderr:\n${err.stderr ?? ''}`);
  }
  return JSON.parse(out.trim());
}

const graph = (): WorkflowGraph => ({
  nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
    { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'create the proof file' } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'a' }],
});

// A stub that emits a claude-style result line carrying structured_output — the $0 seam for slice-3
// data passing. Every agent spawn in the run runs this same command (MC_DAEMON_EXEC is process-wide).
const STRUCTURED_STUB = `echo '{"type":"result","result":"ok","structured_output":{"topic":"otters"},"total_cost_usd":0}'`;

type StepOut = { prompt?: string; result?: { structured_output?: Record<string, unknown> } | null };

describe('workflow runner — mc workflow run (stub executor)', () => {
  let projectId: string;
  let repoPath: string;

  beforeEach(async () => {
    repoPath = mkdtempSync(join(tmpdir(), 'wf-e2e-'));
    const p = await createProject({
      name: `vitest-wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      category: 'internal',
      status: 'prelaunch',
      repoPath,
    });
    projectId = p.id;
  });

  afterEach(async () => {
    await db.delete(events).where(eq(events.projectId, projectId));
    await db.delete(runs).where(eq(runs.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId)); // cascades workflows → workflow_runs → step_runs
    rmSync(repoPath, { recursive: true, force: true });
  });

  it(
    'runs manual → agent, links a real run on the step, creates NO claimable task, and pins a graph snapshot',
    async () => {
      const slug = `vt-wf-${Date.now()}`;
      await createWorkflow({ projectId, slug, name: slug, graph: graph() });

      // The stub agent "does work" by creating a file in the project repo (proves the node actually spawned).
      const res = runWorkflowCli(slug, 'touch wf-proof.txt');
      expect(res.ok).toBe(true);
      expect(res.data?.status).toBe('completed');
      expect(existsSync(join(repoPath, 'wf-proof.txt'))).toBe(true); // the agent node really executed

      const agentStep = res.data!.steps.find((s) => s.nodeId === 'a')!;
      expect(agentStep.status).toBe('completed');
      expect(agentStep.runId).toBeTruthy(); // run-only: the step links a real runs row

      // The linked run exists and is attributed to this project.
      const [runRow] = await db.select().from(runs).where(eq(runs.id, agentStep.runId!));
      expect(runRow).toBeTruthy();
      expect(runRow.projectId).toBe(projectId);

      // CRITICAL: run-only means NO claimable task was created — the auto-claim daemon can't race the walker.
      expect(await getNextClaimableTask({ projectId })).toBeNull();

      // The workflow run pinned the graph it executed.
      const wfRun = await getWorkflowRun(res.data!.workflowRunId);
      expect(wfRun?.status).toBe('completed');
      expect(wfRun?.graphSnapshot.nodes.length).toBe(2);

      // The run lifecycle is on the event log.
      const evts = await db.select().from(events).where(eq(events.runId, agentStep.runId!));
      const types = evts.map((e) => e.type);
      expect(types).toContain('run.started');
      expect(types).toContain('run.ended');

      // Per-node step rows persisted (resumable substrate).
      const steps = await listStepRuns(res.data!.workflowRunId);
      expect(steps.map((s) => s.nodeId).sort()).toEqual(['a', 't']);
    },
    60000,
  );

  it(
    'passes structured output from one agent node to the next via {{nodeId.field}}',
    async () => {
      const slug = `vt-wf-pass-${Date.now()}`;
      // t → a → b; b's prompt consumes a's structured_output. (a's prompt has no refs.)
      await createWorkflow({
        projectId,
        slug,
        name: slug,
        graph: {
          nodes: [
            { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
            { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'find a topic' } },
            { id: 'b', type: 'agent', position: { x: 320, y: 0 }, data: { prompt: 'write about {{a.output.topic}} now' } },
          ],
          edges: [{ id: 'e1', source: 't', target: 'a' }, { id: 'e2', source: 'a', target: 'b' }],
        },
      });

      const res = runWorkflowCli(slug, STRUCTURED_STUB);
      expect(res.ok).toBe(true);
      expect(res.data?.status).toBe('completed');

      const steps = await listStepRuns(res.data!.workflowRunId);
      const a = steps.find((s) => s.nodeId === 'a')!;
      const b = steps.find((s) => s.nodeId === 'b')!;
      expect(a.status).toBe('completed');
      expect(b.status).toBe('completed');
      // a captured its schema-validated structured output…
      expect((a.output as StepOut).result?.structured_output).toEqual({ topic: 'otters' });
      // …and b's resolved prompt has the {{a.output.topic}} ref substituted with it.
      expect((b.output as StepOut).prompt).toBe('write about otters now');
    },
    60000,
  );

  it(
    'hard-fails a node whose {{ref}} resolves to a missing field (default onError=halt stops the run)',
    async () => {
      const slug = `vt-wf-miss-${Date.now()}`;
      await createWorkflow({
        projectId,
        slug,
        name: slug,
        graph: {
          nodes: [
            { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
            { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'find a topic' } },
            { id: 'b', type: 'agent', position: { x: 320, y: 0 }, data: { prompt: 'use {{a.output.nope}}' } },
          ],
          edges: [{ id: 'e1', source: 't', target: 'a' }, { id: 'e2', source: 'a', target: 'b' }],
        },
      });

      const res = runWorkflowCli(slug, STRUCTURED_STUB);
      expect(res.data?.status).toBe('failed');
      const steps = await listStepRuns(res.data!.workflowRunId);
      expect(steps.find((s) => s.nodeId === 'a')!.status).toBe('completed');
      const b = steps.find((s) => s.nodeId === 'b')!;
      expect(b.status).toBe('failed');
      expect(b.error).toMatch(/unresolved data references/i);
      expect(b.runId).toBeNull(); // failed before opening a run (no spawn)
    },
    60000,
  );

  it(
    'onError:continue walks past a failed node — a node sequenced after it still runs',
    async () => {
      const slug = `vt-wf-cont-${Date.now()}`;
      // t → a → b → c. b fails (missing ref) but onError=continue; c is edge-after b but references nothing.
      await createWorkflow({
        projectId,
        slug,
        name: slug,
        graph: {
          nodes: [
            { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
            { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'find a topic' } },
            { id: 'b', type: 'agent', position: { x: 320, y: 0 }, data: { prompt: 'use {{a.output.nope}}', onError: 'continue' } },
            { id: 'c', type: 'agent', position: { x: 480, y: 0 }, data: { prompt: 'wrap up' } },
          ],
          edges: [
            { id: 'e1', source: 't', target: 'a' },
            { id: 'e2', source: 'a', target: 'b' },
            { id: 'e3', source: 'b', target: 'c' },
          ],
        },
      });

      const res = runWorkflowCli(slug, STRUCTURED_STUB);
      expect(res.data?.status).toBe('failed'); // a continued failure still fails the overall run
      const steps = await listStepRuns(res.data!.workflowRunId);
      expect(steps.find((s) => s.nodeId === 'b')!.status).toBe('failed');
      expect(steps.find((s) => s.nodeId === 'c')!.status).toBe('completed'); // walk continued past b
    },
    60000,
  );

  it('returns VALIDATION for an unknown workflow slug', () => {
    const res = runWorkflowCli('does-not-exist-' + Date.now(), 'exit 0');
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('NOT_FOUND');
  });

  it('enqueueWorkflowRun creates a queued run and does NOT walk it (the daemon will)', async () => {
    const slug = `vt-wf-enq-${Date.now()}`;
    await createWorkflow({ projectId, slug, name: slug, graph: graph() });
    const { enqueueWorkflowRun } = await import('../lib/workflow-enqueue');
    const run = await enqueueWorkflowRun(slug, { trigger: 'manual' });
    expect(run.status).toBe('queued');
    // Nothing walked: no step rows, and the run is still queued (no in-process execution on the async path).
    expect((await listStepRuns(run.id)).length).toBe(0);
    expect((await getWorkflowRun(run.id))?.status).toBe('queued');
  });

  it('single-flight: enqueue refuses a second run while one is queued', async () => {
    const slug = `vt-wf-sf-${Date.now()}`;
    await createWorkflow({ projectId, slug, name: slug, graph: graph() });
    const { enqueueWorkflowRun } = await import('../lib/workflow-enqueue');
    const { ConflictError } = await import('../lib/validation');
    await enqueueWorkflowRun(slug, { trigger: 'manual' });
    await expect(enqueueWorkflowRun(slug, { trigger: 'manual' })).rejects.toBeInstanceOf(ConflictError);
  });
});

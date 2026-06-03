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

describe('workflow runner — mc workflow run (stub executor)', () => {
  let projectId: string;
  let projectSlug: string;
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
    projectSlug = p.slug;
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

  it('returns VALIDATION for an unknown workflow slug', () => {
    const res = runWorkflowCli('does-not-exist-' + Date.now(), 'exit 0');
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('NOT_FOUND');
  });
});

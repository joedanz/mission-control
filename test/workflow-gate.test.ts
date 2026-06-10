// ABOUTME: Slice-9a human approval gate — proves a `gate` node PAUSES a run (the walker quiesces; the gate
// ABOUTME: step sits 'running'/awaiting and its successors never run) and that `mc workflow approve` resumes
// ABOUTME: it (approve → walk continues; --reject → the gate fails and onError halts). Also: a paused run blocks
// ABOUTME: a duplicate (single-flight) and survives the reaper. Stub executor (MC_DAEMON_EXEC), real Neon.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db/index';
import { projects, runs, events, workflowRuns, type WorkflowGraph } from '../lib/db/schema';
import { createProject } from '../lib/mutations';
import { reapStaleWorkflowRuns } from '../lib/mutations';
import { createWorkflow, getWorkflowRun, listStepRuns } from '../lib/workflow-store';

const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');

type Step = { nodeId: string; status: string; runId: string | null };
type Envelope = { ok: boolean; data?: { status?: string; workflowRunId?: string; steps?: Step[] }; error?: { code: string } };

/** Invoke the worktree CLI `mc workflow <args> --json` with the stub executor; returns the parsed envelope
 *  (mc exits non-zero on error codes but still prints the JSON envelope to stdout — capture it either way). */
function mcWorkflow(args: string[], exec: string): Envelope {
  let out: string;
  try {
    out = execFileSync(tsxBin, ['cli/index.ts', 'workflow', ...args, '--json'], {
      env: { ...process.env, MC_DAEMON_EXEC: exec, MC_ALLOW_DATABASE_URL_FALLBACK: '1', INGEST_TOKEN: '' },
      encoding: 'utf8',
      timeout: 55000,
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    out = err.stdout ?? '';
    if (!out.trim()) throw new Error(`mc workflow ${args.join(' ')} produced no envelope. stderr:\n${err.stderr ?? ''}`);
  }
  return JSON.parse(out.trim());
}

// Scope the spawned daemon to this test's project (M23) + its own lock dir + a blanked COMPOSIO_API_KEY, so a
// resume tick can't drain another (real) project's queued run or take a live external action in the shared DB.
let scopeProjectId: string | undefined;
const gateLockDir = mkdtempSync(join(tmpdir(), 'mc-gate-test-'));

/** Run the workflow-daemon for one tick (claims + walks the test project's queued runs) — the resume path. */
function runDaemonOnce(exec: string): void {
  execFileSync(tsxBin, ['daemon/workflow-daemon.ts', '--once'], {
    env: {
      ...process.env,
      MC_DAEMON_EXEC: exec,
      MC_ALLOW_DATABASE_URL_FALLBACK: '1',
      INGEST_TOKEN: '',
      MC_LOCK_DIR: gateLockDir,
      COMPOSIO_API_KEY: '',
      ...(scopeProjectId ? { MC_WORKFLOW_DAEMON_ONLY_PROJECT: scopeProjectId } : {}),
    },
    encoding: 'utf8',
    timeout: 55000,
  });
}

// t → g (gate) → a (agent). The agent runs ONLY after the gate is approved.
const gateGraph = (): WorkflowGraph => ({
  nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
    { id: 'g', type: 'gate', position: { x: 160, y: 0 }, data: { message: 'Approve the deploy?' } },
    { id: 'a', type: 'agent', position: { x: 320, y: 0 }, data: { prompt: 'do the gated work' } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'g' }, { id: 'e2', source: 'g', target: 'a' }],
});

// Fan-out: t → {g (gate), b (agent)}. b runs immediately; g blocks ONLY its own (empty) downstream.
const parallelGateGraph = (): WorkflowGraph => ({
  nodes: [
    { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
    { id: 'g', type: 'gate', position: { x: 160, y: -60 }, data: {} },
    { id: 'b', type: 'agent', position: { x: 160, y: 60 }, data: { prompt: 'independent work' } },
  ],
  edges: [{ id: 'e1', source: 't', target: 'g' }, { id: 'e2', source: 't', target: 'b' }],
});

const byNode = (steps: Step[] = []): Record<string, Step> => Object.fromEntries(steps.map((s) => [s.nodeId, s]));

describe('workflow gate — pause → approve / reject', () => {
  let projectId: string;
  let repoPath: string;

  beforeEach(async () => {
    repoPath = mkdtempSync(join(tmpdir(), 'wf-gate-'));
    const p = await createProject({
      name: `vitest-wfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      category: 'internal',
      status: 'prelaunch',
      repoPath,
    });
    projectId = p.id;
    scopeProjectId = projectId; // scope the spawned daemon to this project (M23)
  });

  afterEach(async () => {
    await db.delete(events).where(eq(events.projectId, projectId));
    await db.delete(runs).where(eq(runs.projectId, projectId));
    await db.delete(projects).where(eq(projects.id, projectId)); // cascades workflows → workflow_runs → step_runs
    rmSync(repoPath, { recursive: true, force: true });
  });

  it(
    'pauses on the gate (agent does NOT run), then approve resumes to completed',
    async () => {
      const slug = `vt-wfg-${Date.now()}`;
      await createWorkflow({ projectId, slug, name: slug, graph: gateGraph() });

      // RUN: the walker reaches the gate, marks it awaiting, and quiesces → paused. The agent never spawned.
      const run = mcWorkflow(['run', slug], 'touch gated-proof.txt');
      expect(run.ok).toBe(true);
      expect(run.data?.status).toBe('paused');
      const runId = run.data!.workflowRunId!;
      const s1 = byNode(run.data!.steps);
      expect(s1.t.status).toBe('completed');
      expect(s1.g.status).toBe('running'); // gate awaiting a human
      expect(s1.a).toBeUndefined(); // successor never ran
      expect(existsSync(join(repoPath, 'gated-proof.txt'))).toBe(false);

      // A paused run blocks a duplicate (single-flight counts 'paused').
      const dup = mcWorkflow(['run', slug], 'true');
      expect(dup.ok).toBe(false);
      expect(dup.error?.code).toBe('CONFLICT');

      // APPROVE (sync): the run resumes, the gate completes, the agent finally runs.
      const ok = mcWorkflow(['approve', runId, 'g'], 'touch gated-proof.txt');
      expect(ok.ok).toBe(true);
      expect(ok.data?.status).toBe('completed');
      const s2 = byNode(ok.data!.steps);
      expect(s2.g.status).toBe('completed');
      expect(s2.a.status).toBe('completed');
      expect(s2.a.runId).toBeTruthy(); // the agent really spawned a run
      expect(existsSync(join(repoPath, 'gated-proof.txt'))).toBe(true);

      const wfRun = await getWorkflowRun(runId);
      expect(wfRun?.status).toBe('completed');
    },
    60000,
  );

  it(
    'reject fails the gate (onError halt) — the run ends failed and the agent never runs',
    async () => {
      const slug = `vt-wfg-rej-${Date.now()}`;
      await createWorkflow({ projectId, slug, name: slug, graph: gateGraph() });

      const run = mcWorkflow(['run', slug], 'touch should-not-exist.txt');
      expect(run.data?.status).toBe('paused');
      const runId = run.data!.workflowRunId!;

      const rej = mcWorkflow(['approve', runId, 'g', '--reject', '--reason', 'too risky'], 'touch should-not-exist.txt');
      expect(rej.ok).toBe(true);
      expect(rej.data?.status).toBe('failed');
      const s = byNode(rej.data!.steps);
      expect(s.g.status).toBe('failed');
      expect(s.a).toBeUndefined(); // halt: the agent was never launched
      expect(existsSync(join(repoPath, 'should-not-exist.txt'))).toBe(false);
    },
    60000,
  );

  // M33: the workflow-cancel surface (previously only the bare store primitive was tested).
  it(
    'cancels a PAUSED gate run outright (directCancel) → status cancelled',
    async () => {
      const slug = `vt-wfg-cancel-paused-${Date.now()}`;
      await createWorkflow({ projectId, slug, name: slug, graph: gateGraph() });

      const run = mcWorkflow(['run', slug], 'true');
      expect(run.data?.status).toBe('paused');
      const runId = run.data!.workflowRunId!;

      const cancelled = mcWorkflow(['cancel', runId], 'true');
      expect(cancelled.ok).toBe(true);
      expect((await getWorkflowRun(runId))?.status).toBe('cancelled'); // paused → cancelled (won't observe the flag otherwise)
      // single-flight is freed: a new run of the same workflow is now accepted.
      expect(mcWorkflow(['run', slug], 'true').ok).toBe(true);
    },
    60000,
  );

  it(
    'cancels a QUEUED (--async, never-claimed) run outright → status cancelled, no steps walked',
    async () => {
      const slug = `vt-wfg-cancel-queued-${Date.now()}`;
      await createWorkflow({ projectId, slug, name: slug, graph: gateGraph() });

      const queued = mcWorkflow(['run', slug, '--async'], 'true'); // enqueue only; no daemon claims it in-test
      expect(queued.data?.status).toBe('queued');
      const runId = queued.data!.workflowRunId!;

      const cancelled = mcWorkflow(['cancel', runId], 'true');
      expect(cancelled.ok).toBe(true);
      expect((await getWorkflowRun(runId))?.status).toBe('cancelled');
      expect((await listStepRuns(runId)).length).toBe(0); // never walked
    },
    60000,
  );

  it(
    'resumes off-process via --async + the workflow-daemon',
    async () => {
      const slug = `vt-wfg-async-${Date.now()}`;
      await createWorkflow({ projectId, slug, name: slug, graph: gateGraph() });

      const run = mcWorkflow(['run', slug], 'true');
      expect(run.data?.status).toBe('paused');
      const runId = run.data!.workflowRunId!;

      // --async records the decision + requeues (paused→queued); NO inline walk.
      const queued = mcWorkflow(['approve', runId, 'g', '--async'], 'true');
      expect(queued.ok).toBe(true);
      expect(queued.data?.status).toBe('queued');
      expect((await getWorkflowRun(runId))?.status).toBe('queued');

      // The existing daemon claims + resumes it (zero daemon changes for slice 9a).
      runDaemonOnce('true');
      expect((await getWorkflowRun(runId))?.status).toBe('completed');
      const steps = byNode((await listStepRuns(runId)).map((s) => ({ nodeId: s.nodeId, status: s.status, runId: s.runId })));
      expect(steps.a.status).toBe('completed');
    },
    60000,
  );

  it(
    'a gate blocks only its own branch — an independent fan-out node still completes while paused',
    async () => {
      const slug = `vt-wfg-par-${Date.now()}`;
      await createWorkflow({ projectId, slug, name: slug, graph: parallelGateGraph() });

      const run = mcWorkflow(['run', slug], 'true');
      expect(run.data?.status).toBe('paused');
      const s = byNode(run.data!.steps);
      expect(s.b.status).toBe('completed'); // the independent agent drained
      expect(s.g.status).toBe('running'); // the gate still awaits

      const ok = mcWorkflow(['approve', run.data!.workflowRunId!, 'g'], 'true');
      expect(ok.data?.status).toBe('completed');
    },
    60000,
  );

  it(
    'a paused run is NOT reaped (it waits for a human indefinitely)',
    async () => {
      const slug = `vt-wfg-reap-${Date.now()}`;
      await createWorkflow({ projectId, slug, name: slug, graph: gateGraph() });
      const run = mcWorkflow(['run', slug], 'true');
      const runId = run.data!.workflowRunId!;
      expect(run.data?.status).toBe('paused');

      // Force the heartbeat far into the past, then sweep: the reaper only flips 'running' runs → 'failed'.
      await db.update(workflowRuns).set({ lastHeartbeatAt: new Date(Date.now() - 3600_000) }).where(eq(workflowRuns.id, runId));
      const reaped = await reapStaleWorkflowRuns();
      expect(reaped.find((r) => r.id === runId)).toBeUndefined();
      expect((await getWorkflowRun(runId))?.status).toBe('paused');
    },
    60000,
  );
});

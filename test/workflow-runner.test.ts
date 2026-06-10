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
import { projects, runs, events, type WorkflowGraph, type WorkflowNode } from '../lib/db/schema';
import { createProject } from '../lib/mutations';
import { getNextClaimableTask } from '../lib/queries';
import { createWorkflow, getWorkflowRun, listStepRuns } from '../lib/workflow-store';
import { upsertConnection } from '../lib/composio-store';

const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');

/** Invoke the worktree CLI as a subprocess (the real `mc workflow run` path). `exec` becomes the stub
 *  executor's command (run in the project's repoPath); returns the parsed JSON envelope from stdout. */
function runWorkflowCli(slug: string, exec: string, extraEnv: Record<string, string> = {}, extraArgs: string[] = []): { ok: boolean; data?: { status: string; workflowRunId: string; steps: { nodeId: string; status: string; runId: string | null }[] }; error?: { code: string } } {
  // mc exits non-zero on error codes (NOT_FOUND=3 etc.) — execFileSync throws but still carries stdout (the
  // JSON envelope). Capture stdout either way; surface stderr only when stdout has no parseable envelope.
  let out: string;
  try {
    out = execFileSync(tsxBin, ['cli/index.ts', 'workflow', 'run', slug, '--json', ...extraArgs], {
      env: { ...process.env, MC_DAEMON_EXEC: exec, MC_ALLOW_DATABASE_URL_FALLBACK: '1', INGEST_TOKEN: '', ...extraEnv },
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

  // ── Integration nodes (slice 5): a deterministic Composio action, NO LLM. The MC_COMPOSIO_EXEC stub
  // ── returns a canned { successful, data } so the whole path runs at $0 with no network + no real connection.
  type IntStepOut = { kind?: string; data?: Record<string, unknown>; arguments?: Record<string, unknown>; runStatus?: string };
  const seedActiveLinear = (cid = 'ca_test') =>
    upsertConnection(projectId, 'linear', { userId: `mc-proj-${projectId}`, connectedAccountId: cid, status: 'active' });

  it('runs trigger → integration (no run row), capturing the resolved args + the Composio data', async () => {
    const slug = `vt-wf-int-${Date.now()}`;
    await createWorkflow({
      projectId, slug, name: slug,
      graph: {
        nodes: [
          { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
          { id: 'i', type: 'integration', position: { x: 160, y: 0 }, data: { toolkit: 'linear', action: 'LINEAR_LIST_LINEAR_TEAMS', arguments: { limit: 5 } } },
        ],
        edges: [{ id: 'e1', source: 't', target: 'i' }],
      },
    });
    await seedActiveLinear();

    const res = runWorkflowCli(slug, 'exit 0', { MC_COMPOSIO_EXEC: '{"successful":true,"data":{"teams":[{"id":"T1"}]}}' });
    expect(res.ok).toBe(true);
    expect(res.data?.status).toBe('completed');

    const steps = await listStepRuns(res.data!.workflowRunId);
    const i = steps.find((s) => s.nodeId === 'i')!;
    expect(i.status).toBe('completed');
    expect(i.runId).toBeNull(); // integration node opens NO runs row (no LLM)
    const out = i.output as IntStepOut;
    expect(out.kind).toBe('integration');
    expect(out.data).toEqual({ teams: [{ id: 'T1' }] }); // the Composio response is captured
    expect(out.arguments).toEqual({ limit: 5 }); // the resolved arguments are recorded (number preserved)
  });

  it('passes integration output to a downstream agent via {{i.output.field}} (typed)', async () => {
    const slug = `vt-wf-int-pass-${Date.now()}`;
    await createWorkflow({
      projectId, slug, name: slug,
      graph: {
        nodes: [
          { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
          { id: 'i', type: 'integration', position: { x: 160, y: 0 }, data: { toolkit: 'linear', action: 'LINEAR_GET_LINEAR_ISSUE' } },
          { id: 'a', type: 'agent', position: { x: 320, y: 0 }, data: { prompt: 'work on {{i.output.issueId}} now' } },
        ],
        edges: [{ id: 'e1', source: 't', target: 'i' }, { id: 'e2', source: 'i', target: 'a' }],
      },
    });
    await seedActiveLinear();

    // Agent spawn stub (MC_DAEMON_EXEC) + integration stub (MC_COMPOSIO_EXEC) both in play.
    const res = runWorkflowCli(slug, STRUCTURED_STUB, { MC_COMPOSIO_EXEC: '{"successful":true,"data":{"issueId":"ISS-9"}}' });
    expect(res.ok).toBe(true);
    expect(res.data?.status).toBe('completed');
    const steps = await listStepRuns(res.data!.workflowRunId);
    expect(steps.find((s) => s.nodeId === 'i')!.status).toBe('completed');
    expect((steps.find((s) => s.nodeId === 'a')!.output as StepOut).prompt).toBe('work on ISS-9 now');
  });

  it('fails the node (and run) when the toolkit connection is not active', async () => {
    const slug = `vt-wf-int-noconn-${Date.now()}`;
    await createWorkflow({
      projectId, slug, name: slug,
      graph: {
        nodes: [
          { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
          { id: 'i', type: 'integration', position: { x: 160, y: 0 }, data: { toolkit: 'linear', action: 'LINEAR_LIST_LINEAR_TEAMS' } },
        ],
        edges: [{ id: 'e1', source: 't', target: 'i' }],
      },
    });
    await upsertConnection(projectId, 'linear', { userId: `mc-proj-${projectId}`, connectedAccountId: 'ca_x', status: 'expired' });

    const res = runWorkflowCli(slug, 'exit 0', { MC_COMPOSIO_EXEC: '{"successful":true,"data":{}}' });
    expect(res.data?.status).toBe('failed');
    const i = (await listStepRuns(res.data!.workflowRunId)).find((s) => s.nodeId === 'i')!;
    expect(i.status).toBe('failed');
    expect(i.error).toMatch(/not active|expired/i);
  });

  it('fails the node when the Composio action returns successful:false', async () => {
    const slug = `vt-wf-int-fail-${Date.now()}`;
    await createWorkflow({
      projectId, slug, name: slug,
      graph: {
        nodes: [
          { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
          { id: 'i', type: 'integration', position: { x: 160, y: 0 }, data: { toolkit: 'linear', action: 'LINEAR_LIST_LINEAR_TEAMS' } },
        ],
        edges: [{ id: 'e1', source: 't', target: 'i' }],
      },
    });
    await seedActiveLinear();

    const res = runWorkflowCli(slug, 'exit 0', { MC_COMPOSIO_EXEC: '{"successful":false,"error":"rate limited"}' });
    expect(res.data?.status).toBe('failed');
    const i = (await listStepRuns(res.data!.workflowRunId)).find((s) => s.nodeId === 'i')!;
    expect(i.status).toBe('failed');
    expect(i.error).toMatch(/rate limited|composio/i);
  });

  // ── Branch nodes (slice 6a): a deterministic condition pick that ROUTES the walk. The upstream agent stub
  // ── emits a structured `score`; the branch picks a case and the not-taken path's nodes are recorded `skipped`.
  const scoreStub = (n: number) => `echo '{"type":"result","result":"ok","structured_output":{"score":${n}},"total_cost_usd":0}'`;
  // t → a → b(branch); b routes to hi on the 'high' handle (score>=80) else to lo on the 'else' handle.
  const branchGraph = (): WorkflowGraph => ({
    nodes: [
      { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
      { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'score it' } },
      { id: 'b', type: 'branch', position: { x: 320, y: 0 }, data: { cases: [{ name: 'high', when: { left: '{{a.output.score}}', op: 'gte', right: 80 } }] } },
      { id: 'hi', type: 'agent', position: { x: 480, y: -60 }, data: { prompt: 'report {{a.output.score}}' } },
      { id: 'lo', type: 'agent', position: { x: 480, y: 60 }, data: { prompt: 'low path' } },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'a' },
      { id: 'e2', source: 'a', target: 'b' },
      { id: 'e3', source: 'b', target: 'hi', sourceHandle: 'high' },
      { id: 'e4', source: 'b', target: 'lo', sourceHandle: 'else' },
    ],
  });

  it('routes a branch to the matching case, runs that path (data flows across it), and skips the other', async () => {
    const slug = `vt-wf-br-${Date.now()}`;
    await createWorkflow({ projectId, slug, name: slug, graph: branchGraph() });

    const res = runWorkflowCli(slug, scoreStub(88));
    expect(res.ok).toBe(true);
    expect(res.data?.status).toBe('completed');

    const steps = await listStepRuns(res.data!.workflowRunId);
    const b = steps.find((s) => s.nodeId === 'b')!;
    expect(b.status).toBe('completed');
    expect(b.runId).toBeNull(); // a branch opens NO runs row (no LLM)
    expect((b.output as { chosen?: string }).chosen).toBe('high');
    // the taken path ran, and the upstream agent's data resolved THROUGH the branch into it…
    expect(steps.find((s) => s.nodeId === 'hi')!.status).toBe('completed');
    expect((steps.find((s) => s.nodeId === 'hi')!.output as StepOut).prompt).toBe('report 88');
    // …while the not-taken path was skipped (never spawned).
    expect(steps.find((s) => s.nodeId === 'lo')!.status).toBe('skipped');
  }, 60000);

  it('falls through to the else path when no case matches, skipping the matched-case path', async () => {
    const slug = `vt-wf-br-else-${Date.now()}`;
    await createWorkflow({ projectId, slug, name: slug, graph: branchGraph() });

    const res = runWorkflowCli(slug, scoreStub(10)); // 10 < 80 → no case → else
    expect(res.data?.status).toBe('completed');
    const steps = await listStepRuns(res.data!.workflowRunId);
    expect((steps.find((s) => s.nodeId === 'b')!.output as { chosen?: string }).chosen).toBe('else');
    expect(steps.find((s) => s.nodeId === 'lo')!.status).toBe('completed'); // the 'else' handle
    expect(steps.find((s) => s.nodeId === 'hi')!.status).toBe('skipped');
  }, 60000);

  it('a branch that FAILS under onError:continue routes to no edges (both paths skip) while an independent node drains', async () => {
    const slug = `vt-wf-br-failcont-${Date.now()}`;
    // t → a → b(branch, condition refs a MISSING field, onError:continue) → {hi(high), lo(else)}; t → ind (independent)
    const graph: WorkflowGraph = {
      nodes: [
        { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
        { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'score it' } },
        { id: 'b', type: 'branch', position: { x: 320, y: 0 }, data: { cases: [{ name: 'high', when: { left: '{{a.output.nope}}', op: 'gte', right: 80 } }], onError: 'continue' } },
        { id: 'hi', type: 'agent', position: { x: 480, y: -60 }, data: { prompt: 'high path' } },
        { id: 'lo', type: 'agent', position: { x: 480, y: 60 }, data: { prompt: 'low path' } },
        { id: 'ind', type: 'agent', position: { x: 160, y: 120 }, data: { prompt: 'independent' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'hi', sourceHandle: 'high' },
        { id: 'e4', source: 'b', target: 'lo', sourceHandle: 'else' },
        { id: 'e5', source: 't', target: 'ind' },
      ],
    };
    await createWorkflow({ projectId, slug, name: slug, graph });

    const res = runWorkflowCli(slug, scoreStub(88));
    expect(res.data?.status).toBe('failed'); // a failed node ends the run failed, even under onError:continue
    const steps = await listStepRuns(res.data!.workflowRunId);
    expect(steps.find((s) => s.nodeId === 'b')!.status).toBe('failed'); // unresolved condition ref
    expect(steps.find((s) => s.nodeId === 'hi')!.status).toBe('skipped'); // chosen undefined → no edge active
    expect(steps.find((s) => s.nodeId === 'lo')!.status).toBe('skipped');
    expect(steps.find((s) => s.nodeId === 'ind')!.status).toBe('completed'); // independent path still drained
  }, 60000);

  it('routes a branch via the edge label fallback when sourceHandle is absent', async () => {
    const slug = `vt-wf-br-label-${Date.now()}`;
    // The branch routes by edge.sourceHandle ?? edge.label — these edges carry only `label`.
    const graph: WorkflowGraph = {
      nodes: [
        { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
        { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'score it' } },
        { id: 'b', type: 'branch', position: { x: 320, y: 0 }, data: { cases: [{ name: 'hot', when: { left: '{{a.output.score}}', op: 'gte', right: 80 } }] } },
        { id: 'hi', type: 'agent', position: { x: 480, y: -60 }, data: { prompt: 'hot path' } },
        { id: 'lo', type: 'agent', position: { x: 480, y: 60 }, data: { prompt: 'else path' } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a' },
        { id: 'e2', source: 'a', target: 'b' },
        { id: 'e3', source: 'b', target: 'hi', label: 'hot' }, // no sourceHandle — label is the fallback
        { id: 'e4', source: 'b', target: 'lo', label: 'else' },
      ],
    };
    await createWorkflow({ projectId, slug, name: slug, graph });

    const res = runWorkflowCli(slug, scoreStub(88)); // 88 >= 80 → 'hot'
    expect(res.data?.status).toBe('completed');
    const steps = await listStepRuns(res.data!.workflowRunId);
    expect((steps.find((s) => s.nodeId === 'b')!.output as { chosen?: string }).chosen).toBe('hot');
    expect(steps.find((s) => s.nodeId === 'hi')!.status).toBe('completed'); // matched via label fallback
    expect(steps.find((s) => s.nodeId === 'lo')!.status).toBe('skipped');
  }, 60000);

  // M35: OR-join reconvergence + multi-hop skip propagation — the edge-routing layer that lives only in the
  // walker (decidableNodes has a unit test, but run-vs-skip routing across an extra hop did not). Graph:
  //   t → a → b(branch high>=80); b --high--> hi → join ; b --else--> lo → lo2 ; lo → join
  // With score 88 → 'high': hi runs; lo is skipped (else edge inactive); lo2 is skipped TOO (solely behind lo —
  // multi-hop skip); join still runs because hi's edge is active (an OR-join, NOT skipped despite lo's dead edge).
  const orJoinGraph = (): WorkflowGraph => ({
    nodes: [
      { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
      { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'score it' } },
      { id: 'b', type: 'branch', position: { x: 320, y: 0 }, data: { cases: [{ name: 'high', when: { left: '{{a.output.score}}', op: 'gte', right: 80 } }] } },
      { id: 'hi', type: 'agent', position: { x: 480, y: -60 }, data: { prompt: 'hi path' } },
      { id: 'lo', type: 'agent', position: { x: 480, y: 60 }, data: { prompt: 'lo path' } },
      { id: 'lo2', type: 'agent', position: { x: 640, y: 60 }, data: { prompt: 'behind lo' } },
      { id: 'join', type: 'agent', position: { x: 800, y: 0 }, data: { prompt: 'join' } },
    ],
    edges: [
      { id: 'e1', source: 't', target: 'a' },
      { id: 'e2', source: 'a', target: 'b' },
      { id: 'e3', source: 'b', target: 'hi', sourceHandle: 'high' },
      { id: 'e4', source: 'b', target: 'lo', sourceHandle: 'else' },
      { id: 'e5', source: 'hi', target: 'join' },
      { id: 'e6', source: 'lo', target: 'join' },
      { id: 'e7', source: 'lo', target: 'lo2' },
    ],
  });

  it('OR-join runs on one active incoming edge while the other branch (and the node behind it) skip', async () => {
    const slug = `vt-wf-orjoin-${Date.now()}`;
    await createWorkflow({ projectId, slug, name: slug, graph: orJoinGraph() });

    const res = runWorkflowCli(slug, scoreStub(88)); // 'high' → hi path taken, lo path skipped
    expect(res.ok).toBe(true);
    expect(res.data?.status).toBe('completed');

    const steps = await listStepRuns(res.data!.workflowRunId);
    const byId = (id: string) => steps.find((s) => s.nodeId === id)!;
    expect(byId('hi').status).toBe('completed'); // taken path
    expect(byId('lo').status).toBe('skipped'); // not-taken branch
    expect(byId('lo2').status).toBe('skipped'); // multi-hop: solely behind lo, skip propagates
    expect(byId('join').status).toBe('completed'); // OR-join: runs on hi's active edge despite lo's dead edge
  }, 60000);

  it('hard-fails a branch whose condition ref is missing (halt stops the run, no path runs)', async () => {
    const slug = `vt-wf-br-miss-${Date.now()}`;
    await createWorkflow({
      projectId, slug, name: slug,
      graph: {
        nodes: [
          { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
          { id: 'a', type: 'agent', position: { x: 160, y: 0 }, data: { prompt: 'score it' } },
          { id: 'b', type: 'branch', position: { x: 320, y: 0 }, data: { cases: [{ name: 'x', when: { left: '{{a.output.nope}}', op: 'gt', right: 1 } }] } },
          { id: 'hi', type: 'agent', position: { x: 480, y: 0 }, data: { prompt: 'after' } },
        ],
        edges: [
          { id: 'e1', source: 't', target: 'a' },
          { id: 'e2', source: 'a', target: 'b' },
          { id: 'e3', source: 'b', target: 'hi', sourceHandle: 'x' },
        ],
      },
    });

    const res = runWorkflowCli(slug, scoreStub(88)); // a.output has `score`, not `nope`
    expect(res.data?.status).toBe('failed');
    const steps = await listStepRuns(res.data!.workflowRunId);
    const b = steps.find((s) => s.nodeId === 'b')!;
    expect(b.status).toBe('failed');
    expect(b.error).toMatch(/unresolved data references/i);
    expect(b.runId).toBeNull();
    expect(steps.find((s) => s.nodeId === 'hi')).toBeUndefined(); // halt broke the walk before hi
  }, 60000);

  // ── Concurrency (slice 6b): the walker runs independent nodes in parallel (ready-set scheduler), and a
  // ── merge node waits for ALL its branches (wait-all). Proven via overlapping step [startedAt, endedAt].
  const sleepStub = (sec: number, score: number) =>
    `sleep ${sec}; echo '{"type":"result","result":"ok","structured_output":{"score":${score}},"total_cost_usd":0}'`;
  const ms = (d: Date | null) => (d ? new Date(d).getTime() : NaN);
  const fanIn = (extra: WorkflowNode[] = [], extraEdges: { id: string; source: string; target: string }[] = []): WorkflowGraph => ({
    nodes: [
      { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
      { id: 'a', type: 'agent', position: { x: 160, y: -60 }, data: { prompt: 'branch a' } },
      { id: 'b', type: 'agent', position: { x: 160, y: 60 }, data: { prompt: 'branch b' } },
      ...extra,
    ],
    edges: [{ id: 'e1', source: 't', target: 'a' }, { id: 'e2', source: 't', target: 'b' }, ...extraEdges],
  });

  it('runs a fan-out concurrently — two independent agent nodes overlap in time', async () => {
    const slug = `vt-wf-par-${Date.now()}`;
    await createWorkflow({ projectId, slug, name: slug, graph: fanIn() });

    const res = runWorkflowCli(slug, sleepStub(0.6, 1)); // each node sleeps 0.6s; default maxParallel=4
    expect(res.data?.status).toBe('completed');
    const steps = await listStepRuns(res.data!.workflowRunId);
    const a = steps.find((s) => s.nodeId === 'a')!;
    const b = steps.find((s) => s.nodeId === 'b')!;
    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
    // [startedAt, endedAt] intervals overlap ⇒ a and b were in flight at the same time (true concurrency).
    expect(ms(a.startedAt) < ms(b.endedAt) && ms(b.startedAt) < ms(a.endedAt)).toBe(true);
  }, 60000);

  it('--max-parallel 1 serializes the fan-out (no overlap — the cap is honored)', async () => {
    const slug = `vt-wf-ser-${Date.now()}`;
    await createWorkflow({ projectId, slug, name: slug, graph: fanIn() });

    const res = runWorkflowCli(slug, sleepStub(0.5, 1), {}, ['--max-parallel', '1']);
    expect(res.data?.status).toBe('completed');
    const steps = await listStepRuns(res.data!.workflowRunId);
    const a = steps.find((s) => s.nodeId === 'a')!;
    const b = steps.find((s) => s.nodeId === 'b')!;
    // Declaration order is [a, b]; with one slot, b can't start until a has ended.
    expect(ms(b.startedAt)).toBeGreaterThanOrEqual(ms(a.endedAt));
  }, 60000);

  it('a merge node waits for ALL branches and can reference each (wait-all join)', async () => {
    const slug = `vt-wf-merge-${Date.now()}`;
    // t → {a, b} → m; m references BOTH branches' outputs.
    const merge: WorkflowNode = { id: 'm', type: 'agent', position: { x: 320, y: 0 }, data: { prompt: 'merge {{a.output.score}} and {{b.output.score}}' } };
    await createWorkflow({
      projectId, slug, name: slug,
      graph: fanIn([merge], [{ id: 'e3', source: 'a', target: 'm' }, { id: 'e4', source: 'b', target: 'm' }]),
    });

    const res = runWorkflowCli(slug, sleepStub(0.3, 5));
    expect(res.data?.status).toBe('completed');
    const steps = await listStepRuns(res.data!.workflowRunId);
    expect(steps.find((s) => s.nodeId === 'm')!.status).toBe('completed');
    // m only ran after both branches resolved — and both branch values are present in its prompt.
    expect((steps.find((s) => s.nodeId === 'm')!.output as StepOut).prompt).toBe('merge 5 and 5');
  }, 60000);

  it('a fan-out branch failing under halt stops the run; the merge never runs', async () => {
    const slug = `vt-wf-par-halt-${Date.now()}`;
    // b references {{t.output.nope}} — the trigger has no output, so b hard-fails (default onError=halt).
    const bFails: WorkflowNode = { id: 'b', type: 'agent', position: { x: 160, y: 60 }, data: { prompt: 'use {{t.output.nope}}' } };
    const merge: WorkflowNode = { id: 'm', type: 'agent', position: { x: 320, y: 0 }, data: { prompt: 'merge {{a.output.score}}' } };
    await createWorkflow({
      projectId, slug, name: slug,
      graph: {
        nodes: [
          { id: 't', type: 'trigger', position: { x: 0, y: 0 }, data: { trigger: 'manual' } },
          { id: 'a', type: 'agent', position: { x: 160, y: -60 }, data: { prompt: 'branch a' } },
          bFails, merge,
        ],
        edges: [
          { id: 'e1', source: 't', target: 'a' }, { id: 'e2', source: 't', target: 'b' },
          { id: 'e3', source: 'a', target: 'm' }, { id: 'e4', source: 'b', target: 'm' },
        ],
      },
    });

    const res = runWorkflowCli(slug, sleepStub(0.2, 1));
    expect(res.data?.status).toBe('failed');
    const steps = await listStepRuns(res.data!.workflowRunId);
    expect(steps.find((s) => s.nodeId === 'b')!.status).toBe('failed');
    expect(steps.find((s) => s.nodeId === 'm')).toBeUndefined(); // halt stopped launching before the merge
  }, 60000);
});

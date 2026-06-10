// ABOUTME: DB CRUD for workflows + workflow_runs + workflow_step_runs. Pure Drizzle (no graph logic, no
// ABOUTME: spawn) — the DB-testable seam under the CLI + daemon walker, mirroring lib/composio-store.ts.

import { eq, and, asc, desc, count, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from './db/index';
import {
  workflows, workflowRuns, workflowStepRuns,
  type Workflow, type WorkflowRun, type WorkflowStepRun,
  type WorkflowGraph, type WorkflowStatus, type WorkflowRunStatus, type WorkflowTrigger, type WorkflowStepStatus,
} from './db/schema';
import { ConflictError } from './validation';

/** True if `err` is a Postgres unique-violation (23505) on the given constraint. neon-http nests the driver
 *  error: drizzle throws a DrizzleQueryError whose `.cause` is the NeonDbError carrying `.code`/`.constraint`,
 *  so a top-level check misses it — walk the cause chain (mirrors lib/mutations.ts uniqueViolationHint). */
function isUniqueViolationOn(err: unknown, constraint: string): boolean {
  for (let e: unknown = err; e != null; e = (e as { cause?: unknown }).cause) {
    const c = e as { code?: string; constraint?: string };
    if (c.code === '23505' && c.constraint === constraint) return true;
  }
  return false;
}

// ── Workflows ────────────────────────────────────────────────────────────────────────
export async function createWorkflow(input: {
  projectId: string;
  slug: string;
  name: string;
  description?: string | null;
  graph?: WorkflowGraph;
  status?: WorkflowStatus;
}): Promise<Workflow> {
  const rows = await db
    .insert(workflows)
    .values({
      projectId: input.projectId,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      ...(input.graph !== undefined && { graph: input.graph }),
      ...(input.status !== undefined && { status: input.status }),
    })
    .returning();
  return rows[0];
}

export async function getWorkflowBySlug(slug: string): Promise<Workflow | null> {
  const rows = await db.select().from(workflows).where(eq(workflows.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function getWorkflowById(id: string): Promise<Workflow | null> {
  const rows = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listWorkflows(opts: { projectId?: string; status?: WorkflowStatus } = {}): Promise<Workflow[]> {
  const filters = [
    ...(opts.projectId ? [eq(workflows.projectId, opts.projectId)] : []),
    ...(opts.status ? [eq(workflows.status, opts.status)] : []),
  ];
  const q = db.select().from(workflows).$dynamic();
  if (filters.length) q.where(and(...filters));
  return q.orderBy(desc(workflows.createdAt));
}

export async function setWorkflowStatus(slug: string, status: WorkflowStatus): Promise<Workflow | null> {
  const rows = await db
    .update(workflows)
    .set({ status, updatedAt: new Date() })
    .where(eq(workflows.slug, slug))
    .returning();
  return rows[0] ?? null;
}

/** Save an edited graph (slice 9b canvas authoring). Replaces `graph`, bumps `version`, touches
 *  `updatedAt`, and optionally renames/re-describes. Returns the updated row, or null if no workflow
 *  has that slug. The caller validates the graph (`validateGraph`) BEFORE persisting — this is pure CRUD. */
export async function updateWorkflowGraph(
  slug: string,
  graph: WorkflowGraph,
  opts: { name?: string; description?: string | null } = {},
): Promise<Workflow | null> {
  const rows = await db
    .update(workflows)
    .set({
      graph,
      version: sql`${workflows.version} + 1`,
      updatedAt: new Date(),
      ...(opts.name !== undefined && { name: opts.name }),
      ...(opts.description !== undefined && { description: opts.description }),
    })
    .where(eq(workflows.slug, slug))
    .returning();
  return rows[0] ?? null;
}

// ── Workflow runs ──────────────────────────────────────────────────────────────────────
export async function createWorkflowRun(input: {
  workflowId: string;
  trigger: WorkflowTrigger;
  graphSnapshot: WorkflowGraph;
  context?: unknown;
  // 'running' = the synchronous CLI path (owns its process, walks inline). 'queued' = the async/web path
  // (the workflow-daemon claims it). Defaults to the column default ('running') for the slice-1 behaviour.
  status?: WorkflowRunStatus;
  // false (default) → single_flight_key = workflowId, so the partial unique index refuses a second pending run
  // for this workflow (race-safe, closing the count-then-insert gap). true → key NULL, so concurrent runs coexist.
  allowConcurrent?: boolean;
}): Promise<WorkflowRun> {
  try {
    const rows = await db
      .insert(workflowRuns)
      .values({
        workflowId: input.workflowId,
        trigger: input.trigger,
        graphSnapshot: input.graphSnapshot,
        singleFlightKey: input.allowConcurrent ? null : input.workflowId,
        ...(input.context !== undefined && { context: input.context }),
        ...(input.status !== undefined && { status: input.status }),
      })
      .returning();
    return rows[0];
  } catch (e) {
    // The hard single-flight guarantee: a concurrent enqueue that the count pre-check missed (two webhook
    // redeliveries racing) hits the partial unique index → 23505. Surface it as the same ConflictError the
    // pre-check throws, so the route/CLI map it identically (200 fired:false / exit CONFLICT) — no duplicate run.
    if (isUniqueViolationOn(e, 'workflow_runs_single_flight_uq')) {
      throw new ConflictError('workflow', 'a run is already queued or in progress');
    }
    throw e;
  }
}

/** Race-safe claim of a queued run for the workflow-daemon: flip queued→running and stamp a heartbeat in
 *  ONE conditional statement, returning the row only if THIS caller won. A loser (another daemon already
 *  claimed it, or it was cancelled before pickup) gets null and skips. Mirrors claimTask — no transaction
 *  needed (a single UPDATE is atomic on neon-http). */
export async function claimWorkflowRun(id: string): Promise<WorkflowRun | null> {
  const rows = await db
    .update(workflowRuns)
    .set({ status: 'running', lastHeartbeatAt: new Date() })
    .where(and(eq(workflowRuns.id, id), eq(workflowRuns.status, 'queued')))
    .returning();
  return rows[0] ?? null;
}

/** The workflow-daemon's poll query: queued runs awaiting a claim, oldest-first (FIFO). An optional projectId
 *  scopes to one project's workflows (joins workflow_runs → workflows) — the daemon uses it under
 *  MC_WORKFLOW_DAEMON_ONLY_PROJECT so a test tick can't drain another project's real queued runs (M23). */
export async function listQueuedWorkflowRuns(limit = 20, projectId?: string): Promise<WorkflowRun[]> {
  if (projectId) {
    const rows = await db
      .select({ run: workflowRuns })
      .from(workflowRuns)
      .innerJoin(workflows, eq(workflowRuns.workflowId, workflows.id))
      .where(and(eq(workflowRuns.status, 'queued'), eq(workflows.projectId, projectId)))
      .orderBy(asc(workflowRuns.startedAt))
      .limit(limit);
    return rows.map((r) => r.run);
  }
  return db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.status, 'queued'))
    .orderBy(asc(workflowRuns.startedAt))
    .limit(limit);
}

export async function getWorkflowRun(id: string): Promise<WorkflowRun | null> {
  const rows = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listWorkflowRuns(opts: { workflowId?: string; status?: WorkflowRunStatus; limit?: number } = {}): Promise<WorkflowRun[]> {
  const filters = [
    ...(opts.workflowId ? [eq(workflowRuns.workflowId, opts.workflowId)] : []),
    ...(opts.status ? [eq(workflowRuns.status, opts.status)] : []),
  ];
  const q = db.select().from(workflowRuns).$dynamic();
  if (filters.length) q.where(and(...filters));
  return q.orderBy(desc(workflowRuns.startedAt)).limit(opts.limit ?? 50);
}

/** Pending = a run that is queued, running, OR paused (slice 9a). The single-flight guard refuses a new run
 *  when this is > 0, so a not-yet-claimed queued run still blocks a duplicate (the daemon hasn't picked it up
 *  yet) AND a run paused at an approval gate blocks one too (it is still in-progress, awaiting a human). */
export async function countPendingWorkflowRuns(workflowId: string): Promise<number> {
  const rows = await db
    .select({ c: count() })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.workflowId, workflowId), inArray(workflowRuns.status, ['queued', 'running', 'paused'])));
  return rows[0]?.c ?? 0;
}

/** Resume a paused run (slice 9a) by re-enqueuing it: race-safe paused→queued in ONE conditional statement,
 *  returning the row only if THIS caller won (a loser — already requeued/resumed/cancelled — gets null). The
 *  existing workflow-daemon then claims + walks it unchanged; the walker is resumable, so it skips the decided
 *  gate and continues. The web/async approve path uses this; the CLI sync path flips straight to 'running'. */
export async function requeueWorkflowRun(id: string): Promise<WorkflowRun | null> {
  const rows = await db
    .update(workflowRuns)
    .set({ status: 'queued' })
    .where(and(eq(workflowRuns.id, id), eq(workflowRuns.status, 'paused')))
    .returning();
  return rows[0] ?? null;
}

/** Race-safe claim of a PAUSED run for a synchronous resume (the CLI `mc workflow approve` default): flip
 *  paused→running + heartbeat in ONE statement, returning the row only if THIS caller won. Mirrors
 *  claimWorkflowRun but from 'paused' — so a sync approve and the daemon never both resume the same row. */
export async function claimPausedWorkflowRun(id: string): Promise<WorkflowRun | null> {
  const rows = await db
    .update(workflowRuns)
    .set({ status: 'running', lastHeartbeatAt: new Date() })
    .where(and(eq(workflowRuns.id, id), eq(workflowRuns.status, 'paused')))
    .returning();
  return rows[0] ?? null;
}

/** The startedAt of a workflow's most recent CRON-triggered run, or null if it has never cron-fired. startedAt
 *  is stamped at ENQUEUE (defaultNow on create), not at claim — which is the right cron anchor (fires are spaced
 *  from the scheduled instant, not from execution start). Anchors the cron due-math (isDue) in the workflow-
 *  daemon: only trigger='cron' runs reset the schedule clock, so a manual / async test-run between fires doesn't
 *  skip a scheduled one. Before the first fire the daemon falls back to the workflow's updatedAt (so a freshly-
 *  activated cron waits for its next real instant). */
export async function latestCronRunAt(workflowId: string): Promise<Date | null> {
  const rows = await db
    .select({ startedAt: workflowRuns.startedAt })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.workflowId, workflowId), eq(workflowRuns.trigger, 'cron')))
    .orderBy(desc(workflowRuns.startedAt))
    .limit(1);
  return rows[0]?.startedAt ?? null;
}

// Terminal = the run is over; only then do we stamp endedAt. 'queued' and 'running' are both in-flight.
const TERMINAL_RUN_STATUSES: WorkflowRunStatus[] = ['completed', 'failed', 'cancelled'];

export async function setWorkflowRunStatus(id: string, status: WorkflowRunStatus): Promise<WorkflowRun | null> {
  // Terminal gate (mirrors recordRunEnd): a terminal workflow run is FROZEN. The walker writes the final
  // status unconditionally at the end of its walk; if the reaper already failed a heartbeat-starved run,
  // that write must not resurrect it to 'completed'. Only a non-terminal run (queued/running/paused) takes
  // a new status. Race-safe single statement; a no-op on an already-terminal run returns null.
  const rows = await db
    .update(workflowRuns)
    .set({ status, ...(TERMINAL_RUN_STATUSES.includes(status) ? { endedAt: new Date() } : {}) })
    .where(and(eq(workflowRuns.id, id), notInArray(workflowRuns.status, TERMINAL_RUN_STATUSES)))
    .returning();
  return rows[0] ?? null;
}

export async function requestWorkflowRunCancel(id: string): Promise<WorkflowRun | null> {
  const rows = await db
    .update(workflowRuns)
    .set({ cancelRequested: true })
    .where(eq(workflowRuns.id, id))
    .returning();
  return rows[0] ?? null;
}

/** Liveness heartbeat — the walker bumps this between steps so a dead walker's run goes stale for the reaper. */
export async function touchWorkflowRun(id: string): Promise<WorkflowRun | null> {
  const rows = await db
    .update(workflowRuns)
    .set({ lastHeartbeatAt: new Date() })
    .where(eq(workflowRuns.id, id))
    .returning();
  return rows[0] ?? null;
}

// ── Workflow step runs ──────────────────────────────────────────────────────────────────
type StepPatch = {
  status?: WorkflowStepStatus;
  runId?: string | null;
  output?: unknown;
  error?: string | null;
  startedAt?: Date;
  endedAt?: Date;
};

/** Resolve the `error` column patch. An explicit error always wins. Otherwise, re-running a step into a
 *  NON-failed state (running/pending/completed/skipped) clears any stale error from a PRIOR failed attempt —
 *  without this a step that fails then succeeds keeps displaying its old failure message. An absent status
 *  (a partial patch, e.g. just runId) or a 'failed' status leaves the column untouched. */
function errorSet(status: WorkflowStepStatus | undefined, error: string | null | undefined): { error?: string | null } {
  if (error !== undefined) return { error };
  if (status !== undefined && status !== 'failed') return { error: null };
  return {};
}

/** Idempotent on (workflow_run, node): the unique key makes a re-run reuse the same row, so the walker is
 *  resumable. Only provided fields change on conflict (mirrors composio upsertConnection). */
export async function upsertStepRun(workflowRunId: string, nodeId: string, patch: StepPatch): Promise<WorkflowStepRun> {
  const rows = await db
    .insert(workflowStepRuns)
    .values({ workflowRunId, nodeId, ...patch })
    .onConflictDoUpdate({
      target: [workflowStepRuns.workflowRunId, workflowStepRuns.nodeId],
      set: {
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.runId !== undefined && { runId: patch.runId }),
        ...(patch.output !== undefined && { output: patch.output }),
        ...errorSet(patch.status, patch.error),
        ...(patch.startedAt !== undefined && { startedAt: patch.startedAt }),
        ...(patch.endedAt !== undefined && { endedAt: patch.endedAt }),
      },
    })
    .returning();
  return rows[0];
}

export async function setStepRunStatus(id: string, status: WorkflowStepStatus, patch: Omit<StepPatch, 'status'> = {}): Promise<WorkflowStepRun | null> {
  const terminal = status === 'completed' || status === 'failed' || status === 'skipped';
  const endedAt = terminal ? (patch.endedAt ?? new Date()) : patch.endedAt; // a terminal status stamps an end time
  const rows = await db
    .update(workflowStepRuns)
    .set({
      status,
      ...(patch.runId !== undefined && { runId: patch.runId }),
      ...(patch.output !== undefined && { output: patch.output }),
      ...errorSet(status, patch.error),
      ...(patch.startedAt !== undefined && { startedAt: patch.startedAt }),
      ...(endedAt !== undefined && { endedAt }),
    })
    .where(eq(workflowStepRuns.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function listStepRuns(workflowRunId: string): Promise<WorkflowStepRun[]> {
  return db.select().from(workflowStepRuns).where(eq(workflowStepRuns.workflowRunId, workflowRunId)).orderBy(workflowStepRuns.createdAt);
}

/** One step row by its (workflow_run, node) unique key, or null (slice 9a — a gate reads its own row to learn
 *  its approval decision; the approve path writes the decision onto it). */
export async function getStepRun(workflowRunId: string, nodeId: string): Promise<WorkflowStepRun | null> {
  const rows = await db
    .select()
    .from(workflowStepRuns)
    .where(and(eq(workflowStepRuns.workflowRunId, workflowRunId), eq(workflowStepRuns.nodeId, nodeId)))
    .limit(1);
  return rows[0] ?? null;
}

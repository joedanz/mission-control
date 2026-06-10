// ABOUTME: Framework-agnostic data mutations — the single source of truth for writes.
// ABOUTME: Pure Drizzle, NO auth, NO revalidate. Consumed by app/actions.ts (web) AND cli/index.ts.
//
// Timestamp policy is deliberate and must NOT be normalized:
//   - touchProject sets ONLY lastActivityAt (never updatedAt).
//   - updateProject sets BOTH updatedAt + lastActivityAt.
//   - setProjectRepo sets ONLY updatedAt and does NOT touch lastActivityAt.
//   - createProject sets none (DB defaultNow()).
//   - task writes set completedAt (+updatedAt), then touchProject(projectId).

import { and, eq, inArray, sql, type SQL, type AnyColumn } from 'drizzle-orm';
import { db } from './db/index';
import {
  projects,
  tasks,
  events,
  runs,
  agentProfiles,
  workflowRuns,
  workflowStepRuns,
  type Project,
  type Task,
  type Run,
  type Event,
  type AgentProfile,
  type Category,
  type Status,
  type Accent,
  type Priority,
  type TaskStatus,
  type RunStatus,
  type RunSource,
  type EventType,
  type EventLevel,
  type WorkflowRun,
} from './db/schema';
import { slugify, ConflictError } from './validation';
import { type ProfileInput, type ProfileUpdate, validateProfile } from './profiles';
import { getTaskById, getProfileById } from './queries';
import { getActor, withActor } from './actor-context';
import { CLAIM_TTL_SEC, RUN_STALE_THRESHOLD_SEC, SCHEDULE_MAX_FAILURES } from './constants';

// ── Event log (best-effort, append-only) ────────────────────────────────────────
// recordEvent NEVER throws — a telemetry failure must not fail the state write that
// triggered it (neon-http has no transactions, so the two are independent anyway).
// Attribution comes from the AsyncLocalStorage actor; a missing actor defaults to
// 'system' (the seed/link-repos scripts call the core with no withActor boundary).

export type RecordEventInput = {
  type: EventType;
  summary: string;
  projectId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  level?: EventLevel;
  payload?: unknown;
  tokens?: number | null;
  costMicros?: number | null;
  idempotencyKey?: string | null;
};

/** The events-row insert payload, with actor attribution resolved from the ALS store (defaulting to
 *  'system'). Shared by recordEvent (best-effort) and createEvent (surfaced) so attribution and the
 *  column mapping live in ONE place. */
function eventValues(input: RecordEventInput) {
  const actor = getActor();
  return {
    type: input.type,
    summary: input.summary,
    actorLabel: actor?.label ?? 'system',
    runId: input.runId ?? actor?.runId ?? null,
    projectId: input.projectId ?? null,
    taskId: input.taskId ?? null,
    level: input.level ?? 'info',
    payload: input.payload ?? null,
    tokens: input.tokens ?? null,
    costMicros: input.costMicros ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
  };
}

/** If `err` is a Postgres unique-violation (23505), return a hint (constraint name / detail / message)
 *  for mapping to a clean ConflictError; else null. neon-http nests the driver error: drizzle throws a
 *  DrizzleQueryError whose `.cause` is the NeonDbError carrying `.code` — a top-level `.code` check misses
 *  it, so walk the cause chain. The single source for both the boolean and the hint. */
function uniqueViolationHint(err: unknown): string | null {
  for (let e: unknown = err; e != null; e = (e as { cause?: unknown }).cause) {
    const c = e as { code?: string; constraint?: string; detail?: string; message?: string };
    if (c.code === '23505') return c.constraint ?? c.detail ?? c.message ?? 'unique';
  }
  return null;
}

function isUniqueViolation(err: unknown): boolean {
  return uniqueViolationHint(err) !== null;
}

async function recordEvent(input: RecordEventInput): Promise<void> {
  try {
    await db.insert(events).values(eventValues(input));
  } catch (err) {
    // An idempotencyKey collision (Postgres 23505) is an EXPECTED dedupe of a retried append — silent.
    if (isUniqueViolation(err)) return;
    // Any other failure is best-effort: log and swallow so a telemetry hiccup never fails the state write.
    console.error('[recordEvent] non-fatal:', err instanceof Error ? err.message : err);
  }
}

export type ProjectInput = {
  name: string;
  category: Category;
  status: Status;
  accent?: Accent;
  domain?: string | null;
  techStack?: string[];
  repoPath?: string | null;
  repoUrl?: string | null;
  liveUrl?: string | null;
  sentryProjectSlug?: string | null;
  emailProvider?: string | null;
  emailAddress?: string | null;
  stripeSite?: string | null;
  priority?: Priority | null;
  notes?: string | null;
};

/** Partial — only the keys present are written (serves the CLI's partial `project update`). */
export type ProjectUpdate = Partial<ProjectInput>;

// ── Projects ──────────────────────────────────────────────────────────────────

export async function createProject(input: ProjectInput): Promise<Project> {
  const rows = await db
    .insert(projects)
    .values({
      name: input.name,
      slug: slugify(input.name),
      category: input.category,
      status: input.status,
      accent: input.accent ?? 'orange',
      techStack: input.techStack ?? [],
      domain: input.domain ?? null,
      repoPath: input.repoPath ?? null,
      repoUrl: input.repoUrl ?? null,
      liveUrl: input.liveUrl ?? null,
      sentryProjectSlug: input.sentryProjectSlug ?? null,
      emailProvider: input.emailProvider ?? null,
      emailAddress: input.emailAddress ?? null,
      stripeSite: input.stripeSite ?? null,
      priority: input.priority ?? null,
      notes: input.notes ?? null,
    })
    .returning();
  const project = rows[0];
  await recordEvent({
    type: 'project.created',
    projectId: project.id,
    summary: `Created project "${project.name}"`,
    payload: { category: project.category, status: project.status },
  });
  return project;
}

/** Updates only the provided keys. Does NOT recompute slug (matches the web's behavior).
 *  Returns the updated row, or null if no project matched the id. */
export async function updateProject(id: string, input: ProjectUpdate): Promise<Project | null> {
  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.category !== undefined) set.category = input.category;
  if (input.status !== undefined) set.status = input.status;
  if (input.accent !== undefined) set.accent = input.accent;
  if (input.domain !== undefined) set.domain = input.domain;
  if (input.techStack !== undefined) set.techStack = input.techStack;
  if (input.repoPath !== undefined) set.repoPath = input.repoPath;
  if (input.repoUrl !== undefined) set.repoUrl = input.repoUrl;
  if (input.liveUrl !== undefined) set.liveUrl = input.liveUrl;
  if (input.sentryProjectSlug !== undefined) set.sentryProjectSlug = input.sentryProjectSlug;
  if (input.emailProvider !== undefined) set.emailProvider = input.emailProvider;
  if (input.emailAddress !== undefined) set.emailAddress = input.emailAddress;
  if (input.stripeSite !== undefined) set.stripeSite = input.stripeSite;
  if (input.priority !== undefined) set.priority = input.priority;
  if (input.notes !== undefined) set.notes = input.notes;
  set.updatedAt = new Date();
  set.lastActivityAt = new Date();

  const rows = await db.update(projects).set(set).where(eq(projects.id, id)).returning();
  const project = rows[0] ?? null;
  if (project) {
    const changed = Object.keys(set).filter((k) => k !== 'updatedAt' && k !== 'lastActivityAt');
    await recordEvent({
      type: 'project.updated',
      projectId: project.id,
      summary: `Updated project "${project.name}"`,
      payload: { changed },
    });
  }
  return project;
}

/** Deletes a project (tasks cascade). Returns the deleted row + how many tasks went with it,
 *  or null if no project matched. */
export async function deleteProject(
  id: string,
): Promise<{ project: Project; deletedTaskCount: number } | null> {
  const countRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(eq(tasks.projectId, id));
  const deletedTaskCount = countRows[0]?.n ?? 0;
  const rows = await db.delete(projects).where(eq(projects.id, id)).returning();
  if (!rows[0]) return null;
  const project = rows[0];
  // projectId is null: the row is gone (FK would dangle); the identity lives in the payload.
  await recordEvent({
    type: 'project.deleted',
    projectId: null,
    summary: `Deleted project "${project.name}"`,
    payload: { id: project.id, slug: project.slug, deletedTaskCount },
  });
  return { project, deletedTaskCount };
}

export async function setProjectRepo(
  id: string,
  repoPath: string | null,
  repoUrl: string | null,
): Promise<Project | null> {
  const rows = await db
    .update(projects)
    .set({ repoPath: repoPath || null, repoUrl: repoUrl || null, updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning();
  return rows[0] ?? null;
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

/** Adds a custom task. Assumes a non-empty label (callers guard). */
export async function addTask(projectId: string, label: string): Promise<Task> {
  const rows = await db
    .insert(tasks)
    .values({ projectId, label, status: 'todo' })
    .returning();
  const task = rows[0];
  await Promise.all([
    touchProject(projectId),
    recordEvent({ type: 'task.created', projectId, taskId: task.id, summary: `Added task "${task.label}"` }),
  ]);
  return task;
}

/** Bulk-import custom tasks (the `cc task import-issues` self-sourcing path). Inserts each `{label, notes}`
 *  with ON CONFLICT DO NOTHING on the (project_id, label) partial unique index, so re-importing an
 *  unchanged issue is a silent no-op. Returns ONLY the rows actually inserted (new tasks); emits a
 *  `task.created` event per new task + one touchProject. Callers pre-filter by a stable key (issue number)
 *  for robustness against renamed titles. */
export async function importTasks(
  projectId: string,
  items: { label: string; notes?: string | null }[],
): Promise<Task[]> {
  if (!items.length) return [];
  const inserted = await db
    .insert(tasks)
    .values(items.map((i) => ({ projectId, label: i.label, notes: i.notes ?? null, status: 'todo' as const })))
    .onConflictDoNothing({ target: [tasks.projectId, tasks.label] })
    .returning();
  if (inserted.length) {
    await Promise.all([
      touchProject(projectId),
      ...inserted.map((t) =>
        recordEvent({
          type: 'task.created',
          projectId,
          taskId: t.id,
          summary: `Imported task "${t.label}"`,
          payload: { source: 'github-issues', notes: t.notes },
        }),
      ),
    ]);
  }
  return inserted;
}

/** Flips a task between done and its prior state. Returns the updated row, or null if missing.
 *  The flip is computed by Postgres via a CASE on the live row (single-statement, race-safe on
 *  neon-http) — NOT a read-modify-write. Bumps `version`. */
export async function toggleTask(taskId: string): Promise<Task | null> {
  const updated = await db
    .update(tasks)
    .set({
      status: sql`case when ${tasks.status} = 'done' then 'todo' else 'done' end`,
      completedAt: sql`case when ${tasks.status} = 'done' then null else now() end`,
      version: sql`${tasks.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))
    .returning();
  const row = updated[0];
  if (!row) return null;
  await Promise.all([
    touchProject(row.projectId),
    recordEvent({
      type: 'task.status_changed',
      projectId: row.projectId,
      taskId: row.id,
      summary: `Toggled "${row.label}"`,
      payload: { status: row.status },
    }),
  ]);
  return row;
}

/** Idempotent: sets a custom task's workflow status (todo|in_progress|done). Single-statement
 *  conditional write that folds the projectId read into RETURNING and bumps `version`. A missing
 *  task returns null (CLI NotFound). */
export async function setTaskStatus(taskId: string, status: TaskStatus): Promise<Task | null> {
  const updated = await db
    .update(tasks)
    .set({
      status,
      version: sql`${tasks.version} + 1`,
      completedAt: status === 'done' ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))
    .returning();

  const row = updated[0];
  if (!row) return null;
  await Promise.all([
    touchProject(row.projectId),
    recordEvent({
      type: 'task.status_changed',
      projectId: row.projectId,
      taskId: row.id,
      summary: `Task "${row.label}" → ${status}`,
      payload: { status },
    }),
  ]);
  return row;
}

/** Board move: optionally change a custom task's workflow status AND/OR reindex the sortOrder of its
 *  column — the write behind Kanban drag (between columns and within a column).
 *  Policy (mirrors the board's client-side affordances, enforced here so the CLI/web agree):
 *   - REFUSES a LIVE-claimed task (claim_expires_at in the future). The claim is orthogonal to status;
 *     a human must never yank work out from under a running agent. Live-claimed → returns null (conflict).
 *   - Status change is version-guarded: if `expectedVersion` is given and the row moved since the board
 *     loaded, 0 rows match → null (client reverts; the 4s poll resyncs). completedAt is set/cleared like
 *     setTaskStatus. Moving OUT of `in_progress` clears the claim columns (mirrors releaseClaims) so a
 *     released task can't strand a claim (null claim cols = no TTL rescue; the reaper touches runs, not tasks).
 *   - Reorder reindexes ONLY `orderedIds`, scoped to the task's project, in one parameterized statement
 *     (injection-safe via sql.join). It runs only after a successful (or unchanged) status step, so a
 *     status conflict never reorders a column the card didn't actually move into.
 *  neon-http has no transactions: the status UPDATE and the reindex are separate statements; the residual
 *  gap self-heals on the board's poll. Emits task.status_changed ONLY on a status change (a pure reorder is
 *  silent and does NOT touchProject — re-prioritizing isn't semantic activity). */
export type MoveTaskInput = {
  toStatus?: TaskStatus;
  orderedIds?: string[];
  expectedVersion?: number;
};

export async function moveTask(taskId: string, input: MoveTaskInput): Promise<Task | null> {
  const current = await getTaskById(taskId);
  if (!current) return null;
  // Live claim = a future claim_expires_at (works for null-run manual claims too). Refuse the move.
  if (current.claimExpiresAt && current.claimExpiresAt.getTime() > Date.now()) return null;

  let row: Task = current;
  const statusChanged = input.toStatus !== undefined && input.toStatus !== current.status;

  if (statusChanged && input.toStatus) {
    const leavingInProgress = current.status === 'in_progress';
    const conds = [
      eq(tasks.id, taskId),
      // re-assert not-live-claimed at write time (TOCTOU guard, mirrors claimTask's WHERE)
      sql`(${tasks.claimExpiresAt} is null or ${tasks.claimExpiresAt} < now())`,
    ];
    if (input.expectedVersion !== undefined) conds.push(eq(tasks.version, input.expectedVersion));
    const set: Record<string, unknown> = {
      status: input.toStatus,
      completedAt: input.toStatus === 'done' ? new Date() : null,
      version: sql`${tasks.version} + 1`,
      updatedAt: new Date(),
    };
    if (leavingInProgress) {
      set.claimedByRunId = null;
      set.claimedAt = null;
      set.claimExpiresAt = null;
    }
    const updated = await db.update(tasks).set(set).where(and(...conds)).returning();
    if (!updated[0]) return null; // version conflict, or it raced into a live claim
    row = updated[0];
  }

  if (input.orderedIds && input.orderedIds.length > 0) {
    const values = sql.join(
      input.orderedIds.map((id, i) => sql`(${id}, ${i})`),
      sql`, `,
    );
    // c.ord::int — VALUES literals are untyped, so Postgres infers text and refuses to assign to the
    // integer sort_order column without the cast.
    await db.execute(sql`
      update ${tasks} set sort_order = c.ord::int, updated_at = now()
      from (values ${values}) as c(id, ord)
      where ${tasks.id} = c.id and ${tasks.projectId} = ${current.projectId}
    `);
    const idx = input.orderedIds.indexOf(taskId);
    if (idx >= 0) row = { ...row, sortOrder: idx };
  }

  if (statusChanged) {
    await Promise.all([
      touchProject(row.projectId),
      recordEvent({
        type: 'task.status_changed',
        projectId: row.projectId,
        taskId: row.id,
        summary: `Task "${row.label}" → ${input.toStatus}`,
        payload: { status: input.toStatus, via: 'board' },
      }),
    ]);
  }
  return row;
}

/** Claim a task for an agent run — the Phase 2 self-dispatch primitive. Single-statement conditional
 *  UPDATE (the ONLY race-safe write on neon-http): of N concurrent callers exactly one matches the
 *  WHERE and wins; the losers get 0 rows → ConflictError. Claimable = a CUSTOM task with status 'todo'
 *  AND (unclaimed OR claim expired). The claim is ORTHOGONAL to status (does NOT flip to in_progress). `runId` null = a
 *  manual/operator claim (reclaimable only by TTL). Crash-reclaim is folded into the WHERE via
 *  claim_expires_at. Bumps `version`. Returns null if the task doesn't exist (NotFound). */
export async function claimTask(
  taskId: string,
  runId: string | null,
  ttlSec: number = CLAIM_TTL_SEC,
): Promise<Task | null> {
  const conditions = [
    eq(tasks.id, taskId),
    eq(tasks.status, 'todo'),
    // claim_expires_at is the single claim-state signal (works for null-run manual claims too):
    // NULL = never claimed, future = held, past = expired → claimable. Do NOT key off
    // claimed_by_run_id (a manual claim leaves it NULL, which would let a second caller also win).
    sql`(${tasks.claimExpiresAt} is null or ${tasks.claimExpiresAt} < now())`,
  ];
  if (runId) {
    // One-claim-per-run cap: a run already holding a LIVE claim on another UNFINISHED task can't claim a
    // second. A "run" is a whole agent SESSION working tasks sequentially (claim → set-status done → claim
    // next — cli/README.md), so the cap enforces one in-flight task at a time, which is what lets
    // terminalizeClaimsForRun safely "mark ALL the run's claims done" without completing work the run never
    // did. The `status <> 'done'` term is LOAD-BEARING: set-status done does NOT clear the claim columns
    // (only run.end / release / reclaim do), so a finished task keeps a live claim pointer for up to
    // CLAIM_TTL_SEC — without this term that lingering pointer would wedge the documented claim-next step.
    // Single race-safe statement; runId-gated (a manual null-run claim isn't one agent → no cap). Residual
    // (accepted): only LIVE claims count, so a run holding an UNFINISHED claim past CLAIM_TTL_SEC could
    // carry a stale pointer — closed by the reconcileTerminalClaims backstop (and TTL >> any real task).
    conditions.push(
      sql`not exists (select 1 from ${tasks} t2 where t2.claimed_by_run_id = ${runId} and t2.id <> ${taskId} and t2.claim_expires_at > now() and t2.status <> 'done')`,
    );
  }
  const updated = await db
    .update(tasks)
    .set({
      claimedByRunId: runId,
      claimedAt: new Date(),
      claimExpiresAt: sql`now() + make_interval(secs => ${ttlSec})`,
      version: sql`${tasks.version} + 1`,
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning();

  const row = updated[0];
  if (!row) {
    // 0 rows: disambiguate an absent task (NotFound) from a Conflict (held claim / non-todo / the
    // per-run cap above). The cap branch is reachable only when THIS task is independently claimable
    // (custom + todo + unheld) yet the claim was denied — which, with runId set, means this run already
    // holds a live claim on another unfinished task.
    const existing = await getTaskById(taskId);
    if (!existing) return null;
    const exp = existing.claimExpiresAt;
    const heldNow = !!exp && exp.getTime() > Date.now();
    let reason: string;
    if (heldNow) reason = `claimed until ${exp!.toISOString()}`;
    else if (existing.status !== 'todo') reason = `status=${existing.status}`;
    else reason = `run ${runId?.slice(0, 8)} already holds a live claim on another unfinished task (one in-flight task per run)`;
    throw new ConflictError('task', `Task ${taskId} is not claimable (${reason})`);
  }
  if (runId) {
    // Serialize same-run claims through the run's single slot (M26). Step A's NOT EXISTS cap above checks the
    // TASKS table, so two concurrent `claim --run R` on DIFFERENT rows each evaluate it before the other's
    // write is visible and BOTH pass — leaving R holding two live claims (run-end then marks BOTH done though
    // only one was worked: silent lost work). This UPDATE targets the ONE runs row, so its row lock serializes
    // the racers. The subquery lets a later SEQUENTIAL claim take over the slot once the prior task is
    // done / expired / released / deleted, so no other code path has to clear it.
    const slot = await db
      .update(runs)
      .set({ activeClaimTaskId: taskId })
      .where(
        and(
          eq(runs.id, runId),
          sql`(${runs.activeClaimTaskId} is null
                or ${runs.activeClaimTaskId} = ${taskId}
                or not exists (select 1 from ${tasks} t where t.id = ${runs.activeClaimTaskId}
                     and t.claim_expires_at > now() and t.status <> 'done' and t.claimed_by_run_id = ${runId}))`,
        ),
      )
      .returning({ id: runs.id });
    if (!slot.length) {
      // Lost the slot → another in-flight task already holds it. Roll back the task claim we just made (a
      // compensating release; neon-http has no transactions) and refuse — BEFORE the task.claimed event below.
      await db
        .update(tasks)
        .set({ claimedByRunId: null, claimedAt: null, claimExpiresAt: null, version: sql`${tasks.version} + 1`, updatedAt: new Date() })
        .where(eq(tasks.id, taskId));
      throw new ConflictError('task', `Task ${taskId} is not claimable (run ${runId.slice(0, 8)} already holds a live claim on another unfinished task)`);
    }
  }
  await Promise.all([
    touchProject(row.projectId),
    recordEvent({
      type: 'task.claimed',
      projectId: row.projectId,
      taskId: row.id,
      runId,
      summary: `Task "${row.label}" claimed${runId ? ` by run ${runId.slice(0, 8)}` : ' (manual)'}`,
      payload: { runId, claimExpiresAt: row.claimExpiresAt },
    }),
  ]);
  return row;
}

export async function deleteTask(taskId: string): Promise<Task | null> {
  const rows = await db.delete(tasks).where(eq(tasks.id, taskId)).returning();
  const task = rows[0] ?? null;
  if (task) {
    // taskId omitted (row is gone — FK would dangle); the id lives in the payload.
    await recordEvent({
      type: 'task.deleted',
      projectId: task.projectId,
      summary: `Deleted task "${task.label}"`,
      payload: { taskId: task.id },
    });
  }
  return task;
}

/** Bumps ONLY lastActivityAt (never updatedAt). */
export async function touchProject(projectId: string): Promise<void> {
  await db.update(projects).set({ lastActivityAt: new Date() }).where(eq(projects.id, projectId));
}

// ── Agent profiles (Slice 1) ─────────────────────────────────────────────────────
// Slug-addressed capability bundles + auto-routing rules. validateProfile() enforces the cross-field
// invariants (runtime/permissionMode enums, exec-template-required-for-exec, mcp shape, regex) so the
// web/CLI/tests all get the same guarantees. At most one isDefault row is enforced by the partial
// unique index (a 23505 surfaces as ConflictError) — use setDefaultProfile to flip it safely.

/** Map a profile write's unique violation to a clean, agent-actionable ConflictError (slug dup vs the
 *  single-default index) instead of letting the raw SQL surface. Re-throws anything that isn't a 23505. */
function rethrowProfileConflict(err: unknown, slug: string): never {
  const hint = uniqueViolationHint(err);
  if (hint) {
    if (hint.includes('default')) {
      throw new ConflictError('profile', 'Another profile is already the default — use `mc profile set-default` to change it');
    }
    throw new ConflictError('profile', `A profile with slug "${slug}" already exists`);
  }
  throw err;
}

/** Resolve an update patch onto a current row into the EFFECTIVE shape validateProfile expects. */
function effectiveProfile(current: AgentProfile | null, patch: ProfileUpdate) {
  const v = <T>(p: T | undefined, c: T | undefined): T | undefined => (p !== undefined ? p : c);
  return {
    runtime: (v(patch.runtime, current?.runtime) as string) ?? 'claude-code',
    permissionMode: v(patch.permissionMode, current?.permissionMode),
    execTemplate: v(patch.execTemplate, current?.execTemplate),
    mcpServers: v(patch.mcpServers, current?.mcpServers),
    matchRules: v(patch.matchRules, current?.matchRules),
    dailyBudgetMicros: v(patch.dailyBudgetMicros, current?.dailyBudgetMicros),
    scheduleEnabled: v(patch.scheduleEnabled, current?.scheduleEnabled),
    scheduleProjectId: v(patch.scheduleProjectId, current?.scheduleProjectId),
    scheduleIntervalSec: v(patch.scheduleIntervalSec, current?.scheduleIntervalSec),
    scheduleCron: v(patch.scheduleCron, current?.scheduleCron),
    scheduleTimezone: v(patch.scheduleTimezone, current?.scheduleTimezone),
  };
}

export async function createProfile(input: ProfileInput): Promise<AgentProfile> {
  validateProfile(effectiveProfile(null, input));
  const slug = slugify(input.slug);
  let rows: AgentProfile[];
  try {
    rows = await db
      .insert(agentProfiles)
      .values({
        slug,
        name: input.name,
        description: input.description ?? null,
        runtime: input.runtime ?? 'claude-code',
        model: input.model ?? null,
        provider: input.provider ?? null,
        baseUrl: input.baseUrl ?? null,
        permissionMode: input.permissionMode ?? null,
        fallbackModel: input.fallbackModel ?? null,
        dailyBudgetMicros: input.dailyBudgetMicros ?? null,
        skills: input.skills ?? [],
        mcpServers: input.mcpServers ?? null,
        allowedTools: input.allowedTools ?? [],
        disallowedTools: input.disallowedTools ?? [],
        appendSystemPrompt: input.appendSystemPrompt ?? null,
        env: input.env ?? {},
        execTemplate: input.execTemplate ?? null,
        matchRules: input.matchRules ?? null,
        priority: input.priority ?? 0,
        isDefault: input.isDefault ?? false,
        enabled: input.enabled ?? true,
        scheduleEnabled: input.scheduleEnabled ?? false,
        scheduleProjectId: input.scheduleProjectId ?? null,
        scheduleIntervalSec: input.scheduleIntervalSec ?? null,
        scheduleCron: input.scheduleCron ?? null,
        scheduleTimezone: input.scheduleTimezone ?? null,
        checkInPrompt: input.checkInPrompt ?? null,
      })
      .returning();
  } catch (err) {
    rethrowProfileConflict(err, slug);
  }
  const profile = rows[0];
  await recordEvent({
    type: 'profile.created',
    summary: `Created agent profile "${profile.slug}"`,
    payload: { id: profile.id, runtime: profile.runtime, model: profile.model, isDefault: profile.isDefault },
  });
  return profile;
}

/** Updates only the provided keys (partial). Validates the EFFECTIVE profile (patch merged onto the
 *  current row) so cross-field rules hold even when runtime/execTemplate change in separate calls.
 *  Returns the updated row, or null if no profile matched the id. */
export async function updateProfile(
  id: string,
  input: ProfileUpdate,
  preloaded?: AgentProfile | null,
): Promise<AgentProfile | null> {
  // Callers that already hold the row (the CLI resolved it by slug) pass it in to skip a redundant read.
  const current = preloaded ?? (await getProfileById(id));
  if (!current) return null;
  validateProfile(effectiveProfile(current, input));

  // ProfileUpdate's keys are exactly the column property names, so copy the provided ones straight through
  // (skip undefined for direct callers), then normalize slug. drizzle ignores unknown/extra keys — there are none.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, val] of Object.entries(input)) if (val !== undefined) set[k] = val;
  if (set.slug !== undefined) set.slug = slugify(String(set.slug));

  let rows: AgentProfile[];
  try {
    rows = await db.update(agentProfiles).set(set).where(eq(agentProfiles.id, id)).returning();
  } catch (err) {
    rethrowProfileConflict(err, (set.slug as string) ?? current.slug);
  }
  const profile = rows[0] ?? null;
  if (profile) {
    const changed = Object.keys(set).filter((k) => k !== 'updatedAt');
    await recordEvent({
      type: 'profile.updated',
      summary: `Updated agent profile "${profile.slug}"`,
      payload: { id: profile.id, changed },
    });
  }
  return profile;
}

export type CheckInStatus = 'ok' | 'fail';

/** Record a scheduled check-in for a profile (addressed by slug — the scheduler's natural handle).
 *  With NO status (the scheduler's spawn-time call) it just advances last_check_in_at so the schedule
 *  won't re-fire until it's next due. status='ok' also resets the failure counter; status='fail'
 *  increments it and, at SCHEDULE_MAX_FAILURES consecutive failures, auto-pauses the schedule
 *  (schedule_enabled → false) and emits a warn event. Returns the updated row, or null if no profile
 *  matched the slug. */
export async function recordProfileCheckIn(slug: string, status?: CheckInStatus): Promise<AgentProfile | null> {
  const normalized = slugify(slug);
  const current = (await db.select().from(agentProfiles).where(eq(agentProfiles.slug, normalized)).limit(1))[0] ?? null;
  if (!current) return null;

  const set: Record<string, unknown> = { lastCheckInAt: new Date(), updatedAt: new Date() };
  if (status === 'ok') {
    set.consecutiveFailures = 0;
  } else if (status === 'fail') {
    // Increment and auto-pause IN-DB (single statement) — a JS read-modify-write loses increments when two
    // schedulers report a fail for the same profile concurrently, and could miss the auto-pause threshold.
    set.consecutiveFailures = sql`${agentProfiles.consecutiveFailures} + 1`;
    set.scheduleEnabled = sql`case when ${agentProfiles.scheduleEnabled} and ${agentProfiles.consecutiveFailures} + 1 >= ${SCHEDULE_MAX_FAILURES} then false else ${agentProfiles.scheduleEnabled} end`;
  }

  const profile = (await db.update(agentProfiles).set(set).where(eq(agentProfiles.id, current.id)).returning())[0] ?? null;
  // Emit only on the enabled→disabled transition this call caused (was enabled before, now disabled).
  const paused = status === 'fail' && current.scheduleEnabled && profile != null && !profile.scheduleEnabled;
  if (profile && paused) {
    await recordEvent({
      type: 'profile.updated',
      projectId: profile.scheduleProjectId,
      level: 'warn',
      summary: `Auto-paused check-in for "${profile.slug}" after ${profile.consecutiveFailures} consecutive failures`,
      payload: { id: profile.id, scheduleEnabled: false, consecutiveFailures: profile.consecutiveFailures },
    });
  }
  return profile;
}

/** Make `id` the single global default. neon-http has no transactions, and the partial unique index on
 *  is_default is non-deferrable (so a single "swap" UPDATE trips it mid-statement). So: GUARD on existence
 *  FIRST, then clear every other default, then set the target. The guard is the fix — a non-existent (e.g.
 *  stale-UI) id now returns null WITHOUT clearing the current default into a permanent zero-default state
 *  (the prior clear-then-set order's bug). A concurrent racer setting a different default is still rejected
 *  with 23505 → ConflictError. Returns the new default, or null if `id` is unknown. */
export async function setDefaultProfile(id: string): Promise<AgentProfile | null> {
  const exists = (await db.select({ id: agentProfiles.id }).from(agentProfiles).where(eq(agentProfiles.id, id)).limit(1))[0];
  if (!exists) return null;

  await db
    .update(agentProfiles)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(agentProfiles.isDefault, true), sql`${agentProfiles.id} <> ${id}`));
  let rows: AgentProfile[];
  try {
    rows = await db
      .update(agentProfiles)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(agentProfiles.id, id))
      .returning();
  } catch (err) {
    rethrowProfileConflict(err, id);
  }
  const profile = rows[0] ?? null;
  if (profile) {
    await recordEvent({
      type: 'profile.updated',
      summary: `Set default agent profile → "${profile.slug}"`,
      payload: { id: profile.id, isDefault: true },
    });
  }
  return profile;
}

/** Deletes a profile. Runs that used it keep their row (runs.agentProfileId FK is SET NULL).
 *  Returns the deleted row, or null if no profile matched. */
export async function deleteProfile(id: string): Promise<AgentProfile | null> {
  const rows = await db.delete(agentProfiles).where(eq(agentProfiles.id, id)).returning();
  const profile = rows[0] ?? null;
  if (profile) {
    await recordEvent({
      type: 'profile.deleted',
      summary: `Deleted agent profile "${profile.slug}"`,
      payload: { id: profile.id, slug: profile.slug },
    });
  }
  return profile;
}

// ── Runs (agent sessions) — telemetry write path, shared by the ingest route + `cc run` ─────────
// Token/cost totals are ABSOLUTE cumulative with a GREATEST() monotonic guard so out-of-order or
// duplicate heartbeats can't regress them. run.start upserts by client-supplied id (retry-safe).

export type RunStartInput = {
  id?: string; // client-supplied (hook) so a retried start upserts; else DB default
  agentLabel: string;
  parentRunId?: string | null;
  projectId?: string | null;
  title?: string | null;
  source?: RunSource;
  model?: string | null;
  sessionId?: string | null;
  workDir?: string | null;
  transcriptRef?: string | null;
  agentProfileId?: string | null; // which profile this run used (daemon sets it in Slice 2)
};

export type RunMetrics = {
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMicros?: number;
  model?: string | null;
};

/** Build a metric SET for the provided fields (omitted fields untouched). By default each is GREATEST()
 *  monotonic so out-of-order/duplicate heartbeats can't regress it. `authoritative` SETs the exact value
 *  instead — used when the daemon records claude's own total_cost_usd/usage, which must override the hooks'
 *  transcript estimate even when it's LOWER (GREATEST would otherwise keep the wrong, higher estimate). */
function monotonicMetricSet(m: RunMetrics, authoritative = false): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  const put = (key: keyof RunMetrics, col: AnyColumn, val: number) => {
    set[key] = authoritative ? val : sql`greatest(${col}, ${val})`;
  };
  if (m.tokensIn !== undefined) put('tokensIn', runs.tokensIn, m.tokensIn);
  if (m.tokensOut !== undefined) put('tokensOut', runs.tokensOut, m.tokensOut);
  if (m.cacheReadTokens !== undefined) put('cacheReadTokens', runs.cacheReadTokens, m.cacheReadTokens);
  if (m.cacheWriteTokens !== undefined) put('cacheWriteTokens', runs.cacheWriteTokens, m.cacheWriteTokens);
  if (m.costMicros !== undefined) put('costMicros', runs.costMicros, m.costMicros);
  if (m.model !== undefined) set.model = m.model;
  return set;
}

/** Open (or retry-open) a run. Idempotent on `id`. Emits a deduped `run.started` event. */
export async function recordRunStart(input: RunStartInput): Promise<Run> {
  const rows = await db
    .insert(runs)
    .values({
      id: input.id,
      agentLabel: input.agentLabel,
      parentRunId: input.parentRunId ?? null,
      projectId: input.projectId ?? null,
      title: input.title ?? null,
      source: input.source ?? 'hook',
      model: input.model ?? null,
      sessionId: input.sessionId ?? null,
      workDir: input.workDir ?? null,
      transcriptRef: input.transcriptRef ?? null,
      agentProfileId: input.agentProfileId ?? null,
    })
    .onConflictDoUpdate({
      target: runs.id,
      set: { lastHeartbeatAt: new Date() }, // a retried start just refreshes liveness
    })
    .returning();
  const run = rows[0];
  await recordEvent({
    type: 'run.started',
    runId: run.id,
    projectId: run.projectId,
    summary: `Run started: ${run.agentLabel}${run.title ? ` — ${run.title}` : ''}`,
    payload: { source: run.source, model: run.model },
    idempotencyKey: `run.started:${run.id}`, // dedupe retried starts
  });
  return run;
}

/** Heartbeat: refresh liveness + monotonically advance cumulative totals. Only affects a still-running
 *  run (a late heartbeat can't resurrect a finished one). Returns null if not found/already terminal. */
export async function recordRunHeartbeat(id: string, metrics: RunMetrics = {}): Promise<Run | null> {
  const set = monotonicMetricSet(metrics);
  set.lastHeartbeatAt = sql`greatest(${runs.lastHeartbeatAt}, now())`;
  const rows = await db
    .update(runs)
    .set(set)
    .where(and(eq(runs.id, id), eq(runs.status, 'running')))
    .returning();
  return rows[0] ?? null;
}

/** Operator kill-switch — the WRITE/request half. Flag a RUNNING run for cancellation (sets
 *  `cancel_requested`) and emit an audit event. Enforcement is the hooks' job (R9): the PostToolUse
 *  heartbeat response round-trips this flag, post-tool-use.mjs caches it locally, and pre-tool-use.mjs
 *  halts the turn (continue:false) before the next tool. This write path can be driven by `cc run cancel`
 *  or the Stop button regardless of whether a given run has the enforcement hook wired.
 *  Deliberately orthogonal to liveness — it does NOT touch lastHeartbeatAt, so the reaper still abandons
 *  a genuinely-dead run on its own clock (mirrors how a task claim is orthogonal to task status). Single
 *  statement, race-safe on neon-http; gated on status='running' like recordRunHeartbeat. Returns null if
 *  the run is absent (→ CLI NotFound); throws ConflictError if it exists but already ended. Idempotent:
 *  the deduped event means a repeated request logs once. */
export async function setRunCancelRequested(id: string): Promise<Run | null> {
  const rows = await db
    .update(runs)
    .set({ cancelRequested: true })
    .where(and(eq(runs.id, id), eq(runs.status, 'running')))
    .returning();
  const run = rows[0];
  if (!run) {
    // 0 rows: disambiguate an absent run (→ null → NotFound) from a terminal one (→ Conflict), like claimTask.
    const existing = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
    if (!existing[0]) return null;
    throw new ConflictError('run', `Run ${id} is ${existing[0].status} — only a running run can be cancelled`);
  }
  await recordEvent({
    type: 'run.cancel_requested',
    runId: run.id,
    projectId: run.projectId,
    level: 'warn', // operator intervention, not routine progress — stands out in the feed (matches the UI badge tone)
    summary: `Cancel requested: ${run.agentLabel}`,
    idempotencyKey: `run.cancel_requested:${run.id}`, // one event per run no matter how many requests
  });
  return run;
}

/** Release task claims matching `where` back to the queue — clears the claim columns AND resets an
 *  `in_progress` task to `todo` (`done`/`todo` left as-is). The status reset is load-bearing, not cosmetic:
 *  both queue gates (getNextClaimableTask, claimTask) require status='todo', so releasing an in_progress
 *  task WITHOUT resetting it strands it forever — claim columns are null (no TTL rescue) and the reaper
 *  touches runs, not tasks (no reaper rescue). Bumps `version`. Single statement (race-safe on neon-http).
 *  The ONE place the claim-release write lives; callers supply the trigger predicate (a failed/abandoned
 *  run, or the reaper's batch of abandoned runs). */
async function releaseClaims(where: SQL): Promise<void> {
  await db
    .update(tasks)
    .set({
      status: sql`case when ${tasks.status} = 'in_progress' then 'todo' else ${tasks.status} end`,
      claimedByRunId: null,
      claimedAt: null,
      claimExpiresAt: null,
      version: sql`${tasks.version} + 1`,
      updatedAt: new Date(),
    })
    .where(where);
}

/** Terminalize the task claims a run holds when it ends — this is what CLOSES the self-dispatch loop.
 *  A CLEAN completion auto-marks the run's claimed CUSTOM tasks `done` and clears the claim (the agent
 *  finished what it claimed); any other terminal status RELEASES the claims back to the queue (resetting an
 *  in_progress task to `todo` so it's re-servable), mirroring reapStaleRuns' crash-release. Each branch is
 *  a single statement (race-safe on neon-http). Without this, a completed agent's task sits at 'todo' with
 *  an expiring claim and gets re-served after CLAIM_TTL_SEC — silent duplicate work. Completed tasks emit a
 *  `task.status_changed` event so the auto-completion shows in the feed; release is bulk + eventless (matches
 *  the reaper). Idempotent: a re-sent run.end finds the claims already cleared and is a no-op. */
async function terminalizeClaimsForRun(runId: string, status: RunStatus): Promise<void> {
  if (status !== 'completed') {
    // failed / abandoned: release claims back to the queue (resets in_progress → todo so it's re-servable).
    await releaseClaims(eq(tasks.claimedByRunId, runId));
    return;
  }
  const completed = await db
    .update(tasks)
    .set({
      status: 'done',
      completedAt: sql`coalesce(${tasks.completedAt}, now())`,
      claimedByRunId: null,
      claimedAt: null,
      claimExpiresAt: null,
      version: sql`${tasks.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(tasks.claimedByRunId, runId))
    .returning();
  if (!completed.length) return;
  // Parallelize across the (usually one) completed tasks, and dedup project touches so a multi-task
  // run bumps each project's lastActivityAt once rather than per task.
  const projectIds = [...new Set(completed.map((t) => t.projectId))];
  await Promise.all([
    ...projectIds.map((pid) => touchProject(pid)),
    ...completed.map((t) =>
      recordEvent({
        type: 'task.status_changed',
        projectId: t.projectId,
        taskId: t.id,
        runId,
        summary: `Task "${t.label}" → done (run ${runId.slice(0, 8)} completed)`,
        payload: { status: 'done', via: 'run.end' },
      }),
    ),
  ]);
}

/** Close a run with terminal status + final (monotonic) totals. Idempotent; deduped `run.ended` event.
 *  Also terminalizes the run's task claims (completion closes the self-dispatch loop). */
export async function recordRunEnd(
  id: string,
  status: RunStatus = 'completed',
  metrics: RunMetrics = {},
  authoritative = false,
): Promise<Run | null> {
  const set = monotonicMetricSet(metrics, authoritative);
  // Terminal-status gate + cancel-guard, folded into one conditional UPDATE (race-safe on neon-http).
  //  • Terminal gate: once a run is terminal its status is FROZEN. A late Stop hook (or duplicate run.end)
  //    must not resurrect a reaper-'abandoned' run to 'completed' — which would hide the abandonment AND,
  //    since terminalize then finds no claims, leave the actually-finished task stuck. Metrics below still
  //    apply via GREATEST (a late authoritative cost post on a terminal run is correct), only `status`/the
  //    derived event freeze.
  //  • Cancel-guard: when the caller asks 'completed' but cancel_requested is set, record 'abandoned' so
  //    terminalizeClaimsForRun RELEASES the claim rather than marking unfinished work done.
  // Idempotent under re-post — the Stop hook AND a supervising daemon can both end the run.
  set.status =
    status === 'completed'
      ? sql`case when ${runs.status} <> 'running' then ${runs.status}
                  when ${runs.cancelRequested} then 'abandoned'
                  else 'completed' end`
      : sql`case when ${runs.status} <> 'running' then ${runs.status} else ${status} end`;
  set.endedAt = sql`coalesce(${runs.endedAt}, now())`;
  set.lastHeartbeatAt = sql`greatest(${runs.lastHeartbeatAt}, now())`;
  const rows = await db.update(runs).set(set).where(eq(runs.id, id)).returning();
  const run = rows[0] ?? null;
  if (!run) return null;
  // Close the loop: complete (on success) or release (otherwise) the tasks this run claimed. NOT atomic
  // with the run-status write above (neon-http has no transactions); on a throw between the two, the run
  // is terminal but its claim dangles. That gap is now swept by reconcileTerminalClaims() on the reaper
  // tick (it replays this same terminalize for any terminal run still holding claims), and the
  // completed-run case also self-heals via CLAIM_TTL_SEC re-service + idempotent hook retry.
  // The guard may have rewritten 'completed'→'abandoned'; terminalize + the event use the RECORDED status.
  const recorded = run.status as RunStatus;
  await terminalizeClaimsForRun(run.id, recorded);
  await recordEvent({
    type: 'run.ended',
    runId: run.id,
    projectId: run.projectId,
    summary: `Run ${recorded}: ${run.agentLabel}`,
    payload: { status: recorded, tokensIn: run.tokensIn, tokensOut: run.tokensOut, costMicros: run.costMicros },
    idempotencyKey: `run.ended:${run.id}`,
  });
  return run;
}

/** Reaper: flip `running` runs with no heartbeat within the stale window to 'abandoned' (single
 *  statement, race-safe) and emit a deduped `run.abandoned` event for each. Prevents zombie runs
 *  from a crashed/killed agent showing as "live" forever. Called by the Vercel Cron route. */
export async function reapStaleRuns(): Promise<Run[]> {
  const rows = await db
    .update(runs)
    .set({ status: 'abandoned', endedAt: sql`coalesce(${runs.endedAt}, now())` })
    .where(
      and(
        eq(runs.status, 'running'),
        sql`${runs.lastHeartbeatAt} < now() - make_interval(secs => ${RUN_STALE_THRESHOLD_SEC})`,
      ),
    )
    .returning();
  if (rows.length) {
    // Crash-release: free task claims held by the runs we just abandoned, so a dead agent's work
    // returns to the queue immediately (not only after CLAIM_TTL_SEC).
    await releaseClaims(inArray(tasks.claimedByRunId, rows.map((r) => r.id)));
  }
  for (const r of rows) {
    await recordEvent({
      type: 'run.abandoned',
      runId: r.id,
      projectId: r.projectId,
      summary: `Run abandoned (no heartbeat > ${RUN_STALE_THRESHOLD_SEC}s): ${r.agentLabel}`,
      payload: { agentLabel: r.agentLabel },
      idempotencyKey: `run.abandoned:${r.id}`,
    });
  }
  return rows;
}

/** Backstop for the non-atomic terminalize in recordRunEnd: that function writes a run's terminal status
 *  and THEN terminalizes its claims in a SEPARATE statement (neon-http has no transactions), so a failure
 *  between the two leaves a terminal run still holding a task claim — a completed run's task stuck at
 *  'todo'+claimed (re-served only after CLAIM_TTL_SEC, never auto-completed), or a failed/abandoned run's
 *  claim freed only by TTL. This sweep finds every terminal run that still holds claims and REPLAYS
 *  terminalizeClaimsForRun for it — reusing the exact, idempotent path (completed → done, else release)
 *  rather than reimplementing it. Runs on the reaper tick alongside reapStaleRuns(); in healthy operation
 *  it touches nothing (claims clear inline at run.end). Returns the runs it reconciled. */
export async function reconcileTerminalClaims(): Promise<{ runId: string; status: RunStatus }[]> {
  // selectDistinct so a terminal run holding >1 dangling claim is replayed once. (terminalize is
  // idempotent either way; DB-side distinct just keeps the loop and return value clean.)
  const dangling = await db
    .selectDistinct({ runId: runs.id, status: runs.status })
    .from(tasks)
    .innerJoin(runs, eq(tasks.claimedByRunId, runs.id))
    .where(inArray(runs.status, ['completed', 'failed', 'abandoned'] as RunStatus[]));
  for (const d of dangling) {
    await terminalizeClaimsForRun(d.runId, d.status as RunStatus);
  }
  return dangling.map((d) => ({ runId: d.runId, status: d.status as RunStatus }));
}

/** Reaper for workflow runs: flip `running` workflow_runs whose walker stopped heartbeating (the daemon /
 *  CLI process died mid-walk) to 'failed' and emit a deduped `workflow.abandoned` event for each. Uses the
 *  same stale window + `workflow_runs_status_heartbeat_idx` as reapStaleRuns. QUEUED runs are LEFT alone — a
 *  down workflow-daemon shouldn't fail user-requested work; it resumes claiming on restart. The in-flight
 *  agent step's linked `runs` row is independently abandoned by reapStaleRuns (it heartbeats separately). */
export async function reapStaleWorkflowRuns(): Promise<WorkflowRun[]> {
  const rows = await db
    .update(workflowRuns)
    .set({ status: 'failed', endedAt: sql`coalesce(${workflowRuns.endedAt}, now())` })
    .where(
      and(
        eq(workflowRuns.status, 'running'),
        sql`${workflowRuns.lastHeartbeatAt} < now() - make_interval(secs => ${RUN_STALE_THRESHOLD_SEC})`,
      ),
    )
    .returning();
  if (rows.length) {
    // The dead walker's step rows would otherwise stay non-terminal forever (the in-flight step 'running',
    // undecided successors 'pending'), so `mc workflow status`/the canvas show a perpetually-running step on
    // a failed run. Settle them: the in-flight step → failed, never-started successors → skipped.
    await db
      .update(workflowStepRuns)
      .set({
        status: sql`case when ${workflowStepRuns.status} = 'running' then 'failed' else 'skipped' end`,
        endedAt: sql`now()`,
        error: sql`case when ${workflowStepRuns.status} = 'running' then coalesce(${workflowStepRuns.error}, 'walker abandoned — workflow run reaped (no heartbeat)') else ${workflowStepRuns.error} end`,
      })
      .where(
        and(
          inArray(workflowStepRuns.workflowRunId, rows.map((r) => r.id)),
          inArray(workflowStepRuns.status, ['pending', 'running']),
        ),
      );
  }
  for (const r of rows) {
    await recordEvent({
      type: 'workflow.abandoned',
      summary: `Workflow run abandoned (no heartbeat > ${RUN_STALE_THRESHOLD_SEC}s)`,
      payload: { workflowRunId: r.id, workflowId: r.workflowId },
      idempotencyKey: `workflow.abandoned:${r.id}`,
    });
  }
  return rows;
}

/** One reaper tick as the 'reaper' system actor: abandon stale `running` runs, reconcile any dangling claims
 *  of terminal runs, AND fail stale `running` workflow_runs (dead walkers). Order matters — reap runs first
 *  (abandons + releases), then reconcile catches anything still dangling, so a just-abandoned run converges in
 *  the same tick. The shared core of `npm run reap` and the /api/cron/reap route; both just format the counts. */
export async function runReaperTick(): Promise<{
  reaped: Run[];
  reconciled: { runId: string; status: RunStatus }[];
  staleWorkflows: WorkflowRun[];
}> {
  return withActor({ label: 'reaper', kind: 'system' }, async () => ({
    reaped: await reapStaleRuns(),
    reconciled: await reconcileTerminalClaims(),
    staleWorkflows: await reapStaleWorkflowRuns(),
  }));
}

/** Explicit event append (the `cc event add` / ingest `event` path). Unlike the internal
 *  best-effort recordEvent, this SURFACES errors and returns the row. IDEMPOTENT on idempotencyKey:
 *  a retried append with the same key returns the already-recorded row instead of erroring. */
export async function createEvent(input: RecordEventInput): Promise<Event> {
  const rows = await db
    .insert(events)
    .values(eventValues(input))
    .onConflictDoNothing() // only the partial unique index on idempotencyKey can conflict
    .returning();
  if (rows[0]) return rows[0];
  // Conflict (duplicate idempotencyKey): return the row that already exists — retry-safe, not an error.
  if (input.idempotencyKey) {
    const existing = await db.select().from(events).where(eq(events.idempotencyKey, input.idempotencyKey)).limit(1);
    if (existing[0]) return existing[0];
  }
  throw new Error('createEvent: insert affected no row and no idempotencyKey to recover');
}

// ABOUTME: Read helpers for the dashboard — projects+tasks, derived Sentry/Zoho grids, stats.
// ABOUTME: No `server-only` so the CLI can reuse these. Grids are "loose" with live denominators.

import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from './db/index';
import {
  projects,
  tasks,
  runs,
  events,
  agentProfiles,
  EVENT_LEVELS,
  type Project,
  type Task,
  type Run,
  type Event,
  type EventLevel,
  type AgentProfile,
} from './db/schema';
import { RUN_STALE_THRESHOLD_SEC, type SpendGroupBy } from './constants';
import { profileMatchesContext, type MatchContext } from './profiles';

export type ProjectWithTasks = Project & { tasks: Task[] };

/** Lightweight project row for the global ⌘K palette + breadcrumb (no tasks loaded). */
export type SearchItem = {
  id: string;
  slug: string;
  name: string;
  category: string;
  status: string;
  domain: string | null;
};

export type DashboardStats = {
  total: number;
  prelaunch: number;
  launched: number;
  client: number;
  openSource: number;
};

export type Dashboard = {
  /** Flat, ordered (sortOrder, name) project list — the single source for the unified table. */
  all: ProjectWithTasks[];
  byCategory: {
    internal: ProjectWithTasks[];
    open_source: ProjectWithTasks[];
    client: ProjectWithTasks[];
  };
  stats: DashboardStats;
};

/** A single project (by unique slug) with its tasks. Archived projects ARE returned so a
 *  direct link still resolves; the board itself filters archived out. Null if no such slug. */
export async function getProjectBySlug(slug: string): Promise<ProjectWithTasks | null> {
  const rows = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  const project = rows[0];
  if (!project) return null;
  const projectTasks = await db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, project.id))
    .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt));
  return { ...project, tasks: projectTasks };
}

/** A single task by id, or null. Shared by the CLI's `task get` and the read-modify-write
 *  mutations that need the current row before updating. */
export async function getTaskById(id: string): Promise<Task | null> {
  const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return rows[0] ?? null;
}

/** The next claimable custom task — the agent work-queue peek behind `cc task next`. Claimable =
 *  a `custom` task with status 'todo' that is unclaimed OR whose claim has expired. Ordered by
 *  sortOrder (then createdAt to break ties) so the Kanban board's drag-to-reorder steers what the
 *  daemon picks up next; backed by tasks_claimable_idx on (sortOrder, createdAt). READ-ONLY: the result
 *  is only a CANDIDATE — the actual take is claimTask(), whose single-statement WHERE re-validates and
 *  closes the TOCTOU race. */
export async function getNextClaimableTask(opts: { projectId?: string } = {}): Promise<Task | null> {
  const conds = [
    eq(tasks.status, 'todo'),
    // claimable = never claimed (claim_expires_at NULL) OR the claim has expired (matches claimTask's WHERE)
    sql`(${tasks.claimExpiresAt} is null or ${tasks.claimExpiresAt} < now())`,
  ];
  if (opts.projectId) conds.push(eq(tasks.projectId, opts.projectId));
  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conds))
    .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** All tasks for a project id, ordered like the board (sortOrder, then createdAt). Backs the CLI's
 *  `task move --top/--after`, which needs the destination column's current order to compute orderedIds. */
export async function getTasksByProjectId(projectId: string): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt));
}

/** Just a project's id for a slug (or null) — the cheap lookup the mutation paths need
 *  instead of fetching the project plus its whole task list. */
export async function getProjectIdBySlug(slug: string): Promise<string | null> {
  const rows = await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).limit(1);
  return rows[0]?.id ?? null;
}

/** A full project row by id (or null) — the workflow walker needs a workflow's home project's slug
 *  + repoPath from its stored projectId without paying for the whole task list. */
export async function getProjectById(id: string): Promise<Project | null> {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return rows[0] ?? null;
}

/** A project id whose repoPath exactly matches `repoPath`, or null. Lets the ingest route
 *  auto-associate an agent run with a project from the hook's `cwd` (no slug needed). */
export async function getProjectIdByRepoPath(repoPath: string): Promise<string | null> {
  const rows = await db.select({ id: projects.id }).from(projects).where(eq(projects.repoPath, repoPath)).limit(1);
  return rows[0]?.id ?? null;
}

// ── Agent profiles (Slice 1) ─────────────────────────────────────────────────────

/** All profiles, newest first; optionally filter by enabled flag, runtime, or scheduled-check-in flag. */
export async function getProfiles(
  opts: { enabled?: boolean; runtime?: string; scheduleEnabled?: boolean } = {},
): Promise<AgentProfile[]> {
  const conds = [];
  if (opts.enabled !== undefined) conds.push(eq(agentProfiles.enabled, opts.enabled));
  if (opts.runtime !== undefined) conds.push(eq(agentProfiles.runtime, opts.runtime));
  if (opts.scheduleEnabled !== undefined) conds.push(eq(agentProfiles.scheduleEnabled, opts.scheduleEnabled));
  // and(...[]) → undefined → no filter; ordering done in SQL (matches the rest of this file).
  return db.select().from(agentProfiles).where(and(...conds)).orderBy(desc(agentProfiles.createdAt));
}

export async function getProfileById(id: string): Promise<AgentProfile | null> {
  const rows = await db.select().from(agentProfiles).where(eq(agentProfiles.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getProfileBySlug(slug: string): Promise<AgentProfile | null> {
  const rows = await db.select().from(agentProfiles).where(eq(agentProfiles.slug, slug)).limit(1);
  return rows[0] ?? null;
}

/** The routing brain behind `mc profile resolve` (and, in Slice 2, the daemon). Of the ENABLED profiles
 *  whose matchRules apply to `ctx`, return the highest `priority` (ties broken by oldest createdAt, so the
 *  winner is stable). If none match by rule, fall back to the single isDefault profile. Returns null only
 *  when nothing matches and there is no default. Filtering + ordering happen in JS over the (small) profile
 *  set so the regex/AND match logic stays in one pure place (lib/profiles.profileMatchesContext). */
export async function resolveProfile(ctx: MatchContext): Promise<AgentProfile | null> {
  const enabled = (await db.select().from(agentProfiles).where(eq(agentProfiles.enabled, true)));
  const matches = enabled
    .filter((p) => profileMatchesContext(p.matchRules, ctx))
    .sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime());
  if (matches.length) return matches[0];
  return enabled.find((p) => p.isDefault) ?? null;
}

/** Projects with their tasks, ordered by sort order then name.
 *  `archived`: 'active' (default, non-archived only) | 'archived' (only archived) | 'all'. */
export async function getProjectsWithTasks(
  opts: { archived?: 'active' | 'archived' | 'all' } = {},
): Promise<ProjectWithTasks[]> {
  const mode = opts.archived ?? 'active';
  const projectsQuery =
    mode === 'all'
      ? db.select().from(projects).orderBy(asc(projects.sortOrder), asc(projects.name))
      : db
          .select()
          .from(projects)
          .where(eq(projects.archived, mode === 'archived'))
          .orderBy(asc(projects.sortOrder), asc(projects.name));

  const [allProjects, allTasks] = await Promise.all([
    projectsQuery,
    db.select().from(tasks).orderBy(asc(tasks.sortOrder), asc(tasks.createdAt)),
  ]);

  const tasksByProject = new Map<string, Task[]>();
  for (const t of allTasks) {
    const arr = tasksByProject.get(t.projectId) ?? [];
    arr.push(t);
    tasksByProject.set(t.projectId, arr);
  }

  return allProjects.map((p) => ({ ...p, tasks: tasksByProject.get(p.id) ?? [] }));
}

/** Active (non-archived) projects as a flat search index — the cheap read the global chrome
 *  (top-bar palette + breadcrumb) needs, without loading every project's tasks. */
export async function getSearchIndex(): Promise<SearchItem[]> {
  return db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      category: projects.category,
      status: projects.status,
      domain: projects.domain,
    })
    .from(projects)
    .where(eq(projects.archived, false))
    .orderBy(asc(projects.sortOrder), asc(projects.name));
}

// ── Runs + events (Mission Control) ─────────────────────────────────────────────

/** A run row plus a DERIVED `live` flag (never stored): running + heartbeat within the stale window. */
/** The task a run is currently working — surfaced for the Mission "run X → task Y" view. The claim is
 *  cleared on run-end (terminalizeClaimsForRun), so in practice this is populated only for in-flight runs. */
export type ClaimedTaskRef = { id: string; label: string; projectId: string };

export type RunRow = Run & { live: boolean; claimedTask: ClaimedTaskRef | null };

/** Lean run row for the fleet feed — only the columns the UI renders. Mirrors FEED_EVENT_COLUMNS so the
 *  hot 4s poll never drags the `meta` jsonb blob (or the dozen rarely-read run columns) over the wire. */
export type FeedRunRow = Pick<
  Run,
  'id' | 'agentLabel' | 'status' | 'title' | 'lastHeartbeatAt' | 'tokensIn' | 'tokensOut' | 'costMicros'
>;

/** What getRecentRuns returns: a lean run row + the derived `live` flag + its claimed task. */
export type FleetRunRow = FeedRunRow & { live: boolean; claimedTask: ClaimedTaskRef | null };

/** A single run plus everything the drill-in shows: its `live` flag, the task it's working (if any),
 *  the project it's associated with (for a back-link), and its (lean) event trail. `eventsTruncated`
 *  is true when the run has more events than the cap, so the UI can say so instead of lying. */
export type RunDetail = RunRow & {
  project: { slug: string; name: string } | null;
  events: FeedEventRow[];
  eventsTruncated: boolean;
};

/** Most recent events the drill-in loads for one run. Lean rows (no jsonb) make this cheap; runs
 *  rarely approach it, but when they do the truncation is surfaced rather than silently dropping the start. */
const RUN_EVENT_CAP = 500;

/** Attach the derived `live` flag (never stored). Generic over the row shape so it serves both the lean
 *  fleet projection and the full run row — it only needs `status` + `lastHeartbeatAt`. */
function withLiveness<T extends { status: string; lastHeartbeatAt: Date }>(r: T): T & { live: boolean } {
  const fresh = Date.now() - r.lastHeartbeatAt.getTime() < RUN_STALE_THRESHOLD_SEC * 1000;
  return { ...r, live: r.status === 'running' && fresh };
}

/** The 8 columns FeedRunRow needs — the lean projection for the fleet poll (no `meta` jsonb / unused cols). */
const RUN_FEED_COLUMNS = {
  id: runs.id,
  agentLabel: runs.agentLabel,
  status: runs.status,
  title: runs.title,
  lastHeartbeatAt: runs.lastHeartbeatAt,
  tokensIn: runs.tokensIn,
  tokensOut: runs.tokensOut,
  costMicros: runs.costMicros,
};

/** Recent runs, newest heartbeat first. `active: true` → only `running` runs (the reaper keeps
 *  this honest by flipping stale ones to 'abandoned'). Lean rows only (the fleet feed + `cc run list`);
 *  use getRunById for the full row a single-run drill-in needs. */
export async function getRecentRuns(opts: { active?: boolean; limit?: number; agent?: string } = {}): Promise<FleetRunRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // Filter in SQL so the limit applies AFTER the filters — previously `--agent` filtered the newest-N window
  // client-side, silently dropping matching older runs from both items AND count (M5).
  const conds = [
    ...(opts.active ? [eq(runs.status, 'running')] : []),
    ...(opts.agent ? [eq(runs.agentLabel, opts.agent)] : []),
  ];
  const rows = await db
    .select(RUN_FEED_COLUMNS)
    .from(runs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(runs.lastHeartbeatAt))
    .limit(limit);
  // Attach each run's currently-claimed task (one extra read; claims exist for only a handful of runs).
  // claimedByRunId is cleared on run-end, so this resolves the "run → task" link for in-flight runs.
  const runIds = rows.map((r) => r.id);
  const claims = runIds.length
    ? await db
        .select({ id: tasks.id, label: tasks.label, projectId: tasks.projectId, runId: tasks.claimedByRunId })
        .from(tasks)
        .where(inArray(tasks.claimedByRunId, runIds))
    : [];
  const claimByRun = new Map<string, ClaimedTaskRef>();
  for (const c of claims) {
    if (c.runId && !claimByRun.has(c.runId)) {
      claimByRun.set(c.runId, { id: c.id, label: c.label, projectId: c.projectId });
    }
  }
  return rows.map((r) => ({ ...withLiveness(r), claimedTask: claimByRun.get(r.id) ?? null }));
}

/** A single run by id with its claimed task, associated project, and recent event trail (all levels —
 *  the drill-in shows everything the info-only feed drops, capped at RUN_EVENT_CAP newest). Null if no
 *  such run. Read-only: three independent reads, no atomicity needed. We over-fetch by one row to
 *  detect (and surface) truncation rather than silently dropping the run's start. */
export async function getRunById(id: string): Promise<RunDetail | null> {
  const rows = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  const run = rows[0];
  if (!run) return null;
  const [claimRows, projectRows, runEvents] = await Promise.all([
    db
      .select({ id: tasks.id, label: tasks.label, projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.claimedByRunId, id))
      .limit(1),
    run.projectId
      ? db.select({ slug: projects.slug, name: projects.name }).from(projects).where(eq(projects.id, run.projectId)).limit(1)
      : Promise.resolve([] as { slug: string; name: string }[]),
    getRunEvents({ runId: id, limit: RUN_EVENT_CAP + 1 }),
  ]);
  const claim = claimRows[0];
  const proj = projectRows[0];
  const eventsTruncated = runEvents.length > RUN_EVENT_CAP;
  return {
    ...withLiveness(run),
    claimedTask: claim ? { id: claim.id, label: claim.label, projectId: claim.projectId } : null,
    project: proj ? { slug: proj.slug, name: proj.name } : null,
    events: runEvents.slice(0, RUN_EVENT_CAP), // no-op when under cap; trims the over-fetched +1 when not
    eventsTruncated,
  };
}

// ── Spend rollup ────────────────────────────────────────────────────────────────

export type { SpendGroupBy }; // re-exported from ./constants (single source); used in the signatures below

/** One rollup bucket. `key` is the stable group identity (project slug / agent label / YYYY-MM-DD /
 *  run id); `label` is its display name. Token/cost figures are summed over the bucket's runs;
 *  `costMicros` is micro-dollars (÷ 1e6 for USD). */
export type SpendRow = {
  key: string;
  label: string;
  runCount: number;
  costMicros: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type SpendTotals = Omit<SpendRow, 'key' | 'label'>;

export type SpendRollup = {
  groupBy: SpendGroupBy;
  since: string | null; // ISO; echoes the window the caller asked for (null = unbounded)
  until: string | null;
  rows: SpendRow[]; // top `limit` buckets, spend-desc (day → date-desc)
  totals: SpendTotals; // grand total over the WHOLE filtered window, not just the returned rows
  truncated: boolean; // more buckets exist than were returned
};

/** Cost/usage rolled up over runs, grouped by project | agent | day | run, optionally windowed by start
 *  time and scoped to one project/agent. Sums `runs.costMicros` — the authoritative GREATEST-guarded
 *  per-run total — NOT events, whose cost/token columns are sparse per-event attribution (schema note).
 *  All run statuses count (a running run contributes its cost-so-far). Read-only and the first DB-side
 *  GROUP BY in the repo; two independent SELECTs (buckets + grand totals) need no transaction. */
export async function getSpendRollup(
  opts: {
    groupBy?: SpendGroupBy;
    since?: Date;
    until?: Date;
    projectId?: string;
    agentLabel?: string;
    profileId?: string;
    limit?: number;
  } = {},
): Promise<SpendRollup> {
  const groupBy = opts.groupBy ?? 'project';
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);

  const conds = [];
  if (opts.since) conds.push(gte(runs.startedAt, opts.since));
  if (opts.until) conds.push(lt(runs.startedAt, opts.until));
  if (opts.projectId) conds.push(eq(runs.projectId, opts.projectId));
  if (opts.agentLabel) conds.push(eq(runs.agentLabel, opts.agentLabel));
  if (opts.profileId) conds.push(eq(runs.agentProfileId, opts.profileId));
  const where = conds.length ? and(...conds) : undefined;

  // Postgres SUM(bigint) → numeric, serialized as a string over neon-http; `.mapWith(Number)` coerces
  // each back to a JS number (exact to 2^53, far above any realistic micro/token total). `coalesce`
  // kills the NULL an empty group would otherwise yield. Built fresh per query (no shared SQL objects).
  const aggCols = () => ({
    runCount: sql<number>`count(*)`.mapWith(Number),
    costMicros: sql<number>`coalesce(sum(${runs.costMicros}), 0)`.mapWith(Number),
    tokensIn: sql<number>`coalesce(sum(${runs.tokensIn}), 0)`.mapWith(Number),
    tokensOut: sql<number>`coalesce(sum(${runs.tokensOut}), 0)`.mapWith(Number),
    cacheReadTokens: sql<number>`coalesce(sum(${runs.cacheReadTokens}), 0)`.mapWith(Number),
    cacheWriteTokens: sql<number>`coalesce(sum(${runs.cacheWriteTokens}), 0)`.mapWith(Number),
  });
  const bySpend = desc(sql`coalesce(sum(${runs.costMicros}), 0)`);
  // Day buckets are anchored to UTC EXPLICITLY (not the connection's session timezone GUC) so the CLI
  // and the web app always agree and a run never drifts between calendar days based on who queries.
  const dayBucket = sql`date_trunc('day', ${runs.startedAt} at time zone 'UTC')`;
  const dayLabel = sql<string>`to_char(date_trunc('day', ${runs.startedAt} at time zone 'UTC'), 'YYYY-MM-DD')`;

  // Fetch one extra bucket so truncation is surfaced honestly rather than silently capped.
  const buckets = (() => {
    switch (groupBy) {
      case 'agent': {
        const q = db.select({ key: runs.agentLabel, label: runs.agentLabel, ...aggCols() }).from(runs);
        // asc(agentLabel) is a unique tiebreaker (it's the group key) so tied-spend buckets — and which
        // one the limit+1 truncation drops — are deterministic instead of plan-order-dependent.
        return (where ? q.where(where) : q).groupBy(runs.agentLabel).orderBy(bySpend, asc(runs.agentLabel)).limit(limit + 1);
      }
      case 'day': {
        const q = db.select({ key: dayLabel, label: dayLabel, ...aggCols() }).from(runs);
        return (where ? q.where(where) : q).groupBy(dayBucket).orderBy(desc(dayBucket)).limit(limit + 1);
      }
      case 'run': {
        const q = db
          .select({ key: runs.id, label: sql<string>`coalesce(${runs.title}, ${runs.agentLabel})`, ...aggCols() })
          .from(runs);
        return (where ? q.where(where) : q).groupBy(runs.id).orderBy(bySpend, asc(runs.id)).limit(limit + 1);
      }
      case 'project':
      default: {
        // LEFT JOIN so unassociated (null project_id) runs survive, bucketed under "(unassigned)".
        const q = db
          .select({
            key: sql<string>`coalesce(${projects.slug}, '(unassigned)')`,
            label: sql<string>`coalesce(${projects.name}, '(unassigned)')`,
            ...aggCols(),
          })
          .from(runs)
          .leftJoin(projects, eq(runs.projectId, projects.id));
        return (where ? q.where(where) : q).groupBy(projects.slug, projects.name).orderBy(bySpend, asc(projects.slug)).limit(limit + 1);
      }
    }
  })();

  // Grand totals over the whole filtered window — one row, independent of grouping/limit.
  const totalsQ = db.select(aggCols()).from(runs);
  const totalsQuery = where ? totalsQ.where(where) : totalsQ;

  const [bucketRows, totalsRows] = await Promise.all([buckets, totalsQuery]);
  const truncated = bucketRows.length > limit;
  const t = totalsRows[0];
  const totals: SpendTotals = {
    runCount: t?.runCount ?? 0,
    costMicros: t?.costMicros ?? 0,
    tokensIn: t?.tokensIn ?? 0,
    tokensOut: t?.tokensOut ?? 0,
    cacheReadTokens: t?.cacheReadTokens ?? 0,
    cacheWriteTokens: t?.cacheWriteTokens ?? 0,
  };
  return {
    groupBy,
    since: opts.since ? opts.since.toISOString() : null,
    until: opts.until ? opts.until.toISOString() : null,
    rows: bucketRows.slice(0, limit),
    totals,
    truncated,
  };
}

/** Events, newest first (createdAt, seq). Optional project/run scope; `minLevel` filters by severity
 *  (the activity feed passes 'info' to drop debug-level tool_call noise). */
export async function getEvents(
  opts: { projectId?: string; runId?: string; minLevel?: EventLevel; limit?: number } = {},
): Promise<Event[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const conds = [];
  if (opts.projectId) conds.push(eq(events.projectId, opts.projectId));
  if (opts.runId) conds.push(eq(events.runId, opts.runId));
  if (opts.minLevel) {
    const min = EVENT_LEVELS.indexOf(opts.minLevel);
    conds.push(inArray(events.level, EVENT_LEVELS.slice(min) as string[]));
  }
  const where = conds.length ? and(...conds) : undefined;
  const q = db.select().from(events);
  return (where ? q.where(where) : q).orderBy(desc(events.createdAt), desc(events.seq)).limit(limit);
}

/** Lean feed row — only the columns the UI renders (no `payload` jsonb shipped on the hot poll). */
export type FeedEventRow = Pick<
  Event,
  'id' | 'seq' | 'type' | 'level' | 'summary' | 'actorLabel' | 'runId' | 'projectId' | 'createdAt'
>;

/** The 9 columns FeedEventRow needs — the single no-jsonb projection shared by every hot poll path
 *  (activity feed + run drill-in) so none of them drags the `payload` blob over the wire. */
const FEED_EVENT_COLUMNS = {
  id: events.id,
  seq: events.seq,
  type: events.type,
  level: events.level,
  summary: events.summary,
  actorLabel: events.actorLabel,
  runId: events.runId,
  projectId: events.projectId,
  createdAt: events.createdAt,
};

/** The activity feed: events at info-level or above (drops debug tool_call noise), projected to the
 *  columns the UI uses. Its own query (not getEvents) so the hot poll path doesn't fetch jsonb. */
export function getActivityFeed(opts: { projectId?: string; limit?: number } = {}): Promise<FeedEventRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const minLevel = EVENT_LEVELS.indexOf('info');
  const conds = [inArray(events.level, EVENT_LEVELS.slice(minLevel) as string[])];
  if (opts.projectId) conds.push(eq(events.projectId, opts.projectId));
  return db
    .select(FEED_EVENT_COLUMNS)
    .from(events)
    .where(and(...conds))
    .orderBy(desc(events.createdAt), desc(events.seq))
    .limit(limit);
}

/** A single run's events as lean rows — ALL levels (the drill-in shows everything, including the
 *  debug tool_calls the feed drops), newest first, same no-jsonb projection as the feed so the
 *  drill-in's 4s poll stays light. */
export function getRunEvents(opts: { runId: string; limit?: number }): Promise<FeedEventRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  return db
    .select(FEED_EVENT_COLUMNS)
    .from(events)
    .where(eq(events.runId, opts.runId))
    .orderBy(desc(events.createdAt), desc(events.seq))
    .limit(limit);
}

export async function getDashboard(): Promise<Dashboard> {
  const all = await getProjectsWithTasks();

  const byCategory = {
    internal: all.filter((p) => p.category === 'internal'),
    open_source: all.filter((p) => p.category === 'open_source'),
    client: all.filter((p) => p.category === 'client'),
  };

  const stats: DashboardStats = {
    total: all.length,
    prelaunch: all.filter((p) => p.status === 'prelaunch').length,
    launched: all.filter((p) => p.status === 'launched').length,
    client: byCategory.client.length,
    openSource: byCategory.open_source.length,
  };

  return { all, byCategory, stats };
}

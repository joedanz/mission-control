// ABOUTME: Drizzle schema for the Mission Control dashboard.
// ABOUTME: projects + tasks + settings, plus BetterAuth tables (users/sessions/accounts/verification).

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// ── Enums (stable sets only) ──────────────────────────────────────────────────
export const categoryEnum = pgEnum('category', ['internal', 'open_source', 'client']);
export const accentEnum = pgEnum('accent', ['orange', 'green', 'blue', 'violet', 'warm']);

// Churny sets stay as text, validated in the app/CLI layer:
//   status:             prelaunch | launched | testing | active | design | planning
//   task.kind:          integration | custom
//   integration_type:   google_oauth | stripe | sentry | zoho_email | other
//   task.status:        todo | in_progress | done           (custom tasks)
//   integration_status: needed | pending | done             (integration tasks)

export const STATUSES = ['prelaunch', 'launched', 'testing', 'active', 'design', 'planning'] as const;
export const INTEGRATION_TYPES = ['google_oauth', 'stripe', 'sentry', 'zoho_email', 'other'] as const;
export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const;
export const INTEGRATION_STATUSES = ['needed', 'pending', 'done'] as const;
export const PRIORITIES = ['low', 'medium', 'high'] as const;

// ── Mission Control allow-lists (Phase 1) ───────────────────────────────────────
//   run.status:  running → completed | failed | abandoned   (live/idle is DERIVED from lastHeartbeatAt, not stored)
//   run.source:  how the run was invoked
//   event.level: feed shows >= info; debug retained for replay
export const RUN_STATUSES = ['running', 'completed', 'failed', 'abandoned'] as const;
export const RUN_SOURCES = ['hook', 'cli', 'cron', 'manual'] as const;
export const EVENT_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export const EVENT_TYPES = [
  'project.created',
  'project.updated',
  'project.deleted',
  'task.created',
  'task.status_changed',
  'task.claimed',
  'task.deleted',
  'integration.upserted',
  'run.started',
  'run.ended',
  'run.abandoned',
  'run.cancel_requested',
  'profile.created',
  'profile.updated',
  'profile.deleted',
  'tool_call',
  'composio.connection_changed',
  'note',
] as const;
// Suggested labels for agent/system actors. NOTE: actorLabel/agentLabel are free-text
// (the human actor label is an email, which can't be a fixed enum) — this is guidance, not a constraint.
export const AGENT_LABELS = ['claude-code', 'mc', 'system', 'reaper'] as const;

// ── Agent profiles (Slice 1) ────────────────────────────────────────────────────
//   profile.runtime:  how the daemon spawns a profiled agent.
//     claude-code → rich `claude -p` flags (model/permission-mode/mcp/tools/persona).
//     exec        → a rendered command template (execTemplate), so a profile can drive a NON-Claude
//                   model through any OpenAI-compatible runner. Claude Code is Claude-only, so a
//                   first-class `runtime` field — not a model string — is what makes profiles multi-model.
//   profile.permissionMode: Claude Code permission posture (only meaningful for runtime='claude-code').
export const PROFILE_RUNTIMES = ['claude-code', 'exec'] as const;
export const PERMISSION_MODES = ['plan', 'acceptEdits', 'bypassPermissions', 'default'] as const;
export type ProfileRuntime = (typeof PROFILE_RUNTIMES)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];

// One MCP server entry — the canonical inner shape of Claude Code's `--mcp-config` map. Secrets are
// NEVER stored: header/env values carry `${ENV_VAR}` placeholders that the daemon (Slice 2) resolves
// from the host environment at spawn. stdio = local process; http/sse/ws = remote transport.
export type McpServerConfig = {
  type?: 'stdio' | 'http' | 'sse' | 'ws';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

// Auto-routing predicate set — the daemon matches a claimed task against these; the resolver orders
// surviving profiles by `priority` (desc) and falls back to the single `isDefault` profile. All fields
// are optional and ANDed; an empty ruleset matches nothing (only the default would apply).
export type ProfileMatchRules = {
  projectSlugs?: string[];
  projectCategories?: Category[];
  taskKinds?: string[];
  labelPattern?: string; // a regex tested against task.label
};

// Derived from the pgEnums above so there's one source of truth (no inlined literals).
export const CATEGORIES = categoryEnum.enumValues; // ['internal', 'open_source', 'client']
export const ACCENTS = accentEnum.enumValues; //     ['orange', 'green', 'blue', 'violet', 'warm']

export type Status = (typeof STATUSES)[number];
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Category = (typeof CATEGORIES)[number];
export type Accent = (typeof ACCENTS)[number];
export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunSource = (typeof RUN_SOURCES)[number];
export type EventLevel = (typeof EVENT_LEVELS)[number];
export type EventType = (typeof EVENT_TYPES)[number];

// ── Projects ──────────────────────────────────────────────────────────────────
export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    domain: text('domain'),
    category: categoryEnum('category').notNull(),
    status: text('status').notNull(),
    accent: accentEnum('accent').notNull().default('orange'),
    techStack: jsonb('tech_stack').$type<string[]>().notNull().default([]),
    repoPath: text('repo_path'),
    repoUrl: text('repo_url'),
    liveUrl: text('live_url'),
    sentryProjectSlug: text('sentry_project_slug'), // nullable; null = project has no Errors tab
    emailProvider: text('email_provider'), // nullable; manual provider label override
    emailAddress: text('email_address'),   // nullable; manual primary email address
    stripeSite: text('stripe_site'),       // nullable; metadata.site value, null = no Revenue tab
    priority: text('priority'),
    description: text('description'),
    notes: text('notes'),
    archived: boolean('archived').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    targetDate: date('target_date'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('projects_slug_uq').on(t.slug),
    index('projects_tech_stack_gin').using('gin', t.techStack),
  ],
);

// ── Tasks ───────────────────────────────────────────────────────────────────--
export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    notes: text('notes'),
    kind: text('kind').notNull().default('custom'), // integration | custom
    integrationType: text('integration_type'), // null for custom tasks
    status: text('status').notNull().default('todo'), // custom workflow status
    integrationStatus: text('integration_status'), // tri-state for integration tasks
    sortOrder: integer('sort_order').notNull().default(0),
    // Optimistic-concurrency token, bumped on every status/claim write. No CAS reader today — the bump
    // is the collision signal; claimTask/getNextClaimableTask gate on claim state, not on this version.
    version: integer('version').notNull().default(0),
    // Phase 2 coordination — agent work-queue claim (single-statement, race-safe on neon-http).
    // Claim is ORTHOGONAL to status: claiming does NOT change `status`; getNextClaimableTask gates on
    // status='todo' AND (unclaimed OR claim expired). claimedByRunId FK SET NULL so a deleted run frees
    // the claim, and the reaper frees claims of abandoned runs immediately. claimExpiresAt is the backstop
    // (and the only release for a NULL-run manual/operator claim), so CLAIM_TTL_SEC is deliberately generous.
    claimedByRunId: text('claimed_by_run_id').references((): AnyPgColumn => runs.id, { onDelete: 'set null' }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // one integration row per type per project (keeps derived grids from double-counting)
    uniqueIndex('tasks_project_integration_uq')
      .on(t.projectId, t.integrationType)
      .where(sql`integration_type IS NOT NULL`),
    // lets the custom-task seed use ON CONFLICT (project_id, label)
    uniqueIndex('tasks_project_label_uq')
      .on(t.projectId, t.label)
      .where(sql`integration_type IS NULL`),
    index('tasks_project_idx').on(t.projectId),
    // Phase 2 claim peek (getNextClaimableTask) — partial + FIFO-ordered over ONLY claimable-eligible rows.
    // The auto-claim daemon polls this on a loop; the predicate matches the query's status/kind filter so
    // the planner walks created_at order and applies the claim-expiry test on the small candidate set.
    // Claim-queue head: priority by sortOrder, then FIFO by createdAt. Matches getNextClaimableTask's
    // ORDER BY so the Kanban board's drag-to-reorder steers what the auto-claim daemon picks up next.
    index('tasks_claimable_idx')
      .on(t.sortOrder, t.createdAt)
      .where(sql`status = 'todo' and kind = 'custom'`),
  ],
);

// ── Agent profiles (Slice 1) ─────────────────────────────────────────────────────
// A global, slug-addressed bundle of capabilities (skills / MCP servers / model / tool policy /
// persona) plus auto-routing rules. The daemon (Slice 2) resolves the best-matching profile for a
// claimed task and renders it into either a `claude -p` invocation (runtime='claude-code') or an
// arbitrary executor command (runtime='exec'). MC stores FULL definitions but NEVER a secret —
// mcpServers/env carry `${ENV}` placeholders resolved from the host at spawn.
export const agentProfiles = pgTable(
  'agent_profiles',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    runtime: text('runtime').notNull().default('claude-code'), // PROFILE_RUNTIMES
    model: text('model'), // e.g. opus, claude-sonnet-4-6, gpt-4o, deepseek-v3
    // Cost-aware routing (Slice 4). fallbackModel → claude's `--fallback-model` (overload/unavailable
    // resilience) AND the cheaper model the daemon downgrades to once dailyBudgetMicros is exceeded for
    // the day. dailyBudgetMicros: micro-dollar cap on THIS profile's same-UTC-day run cost (null = no cap);
    // bigint(number) to match runs.cost_micros. The downgrade needs both fields set (a cap with no fallback
    // has nothing to switch to → no-op).
    fallbackModel: text('fallback_model'),
    dailyBudgetMicros: bigint('daily_budget_micros', { mode: 'number' }),
    provider: text('provider'), // null = Claude default; else anthropic | openai | litellm | …
    baseUrl: text('base_url'), // optional gateway/provider endpoint (non-Claude / routed)
    permissionMode: text('permission_mode'), // PERMISSION_MODES (claude-code only)
    skills: jsonb('skills').$type<string[]>().notNull().default([]),
    mcpServers: jsonb('mcp_servers').$type<Record<string, McpServerConfig>>(), // null = none
    allowedTools: jsonb('allowed_tools').$type<string[]>().notNull().default([]),
    disallowedTools: jsonb('disallowed_tools').$type<string[]>().notNull().default([]),
    appendSystemPrompt: text('append_system_prompt'), // persona
    env: jsonb('env').$type<Record<string, string>>().notNull().default({}), // ${ENV} placeholders / non-secret literals
    execTemplate: text('exec_template'), // required when runtime='exec'; tokens: ${MODEL}/${PROMPT}/${MCP_CONFIG}
    matchRules: jsonb('match_rules').$type<ProfileMatchRules>(), // null = matches nothing (default-only)
    priority: integer('priority').notNull().default(0), // tie-break among matches (higher wins)
    isDefault: boolean('is_default').notNull().default(false), // global fallback; partial-unique below
    enabled: boolean('enabled').notNull().default(true),
    // ── Scheduled check-ins (Slice 5) ────────────────────────────────────────────
    //   A check-in is a SCHEDULED wake-up (Cabinet's sense of "heartbeat") — distinct from the liveness
    //   heartbeat (runs.lastHeartbeatAt). When due, the scheduler daemon spawns one run, bound to
    //   scheduleProjectId's repo, with checkInPrompt as the standing mission; the agent then self-serves
    //   that project's queued tasks via the mc CLI. Due = interval (now − lastCheckInAt ≥ intervalSec) or,
    //   when scheduleCron is set, the cron's next fire after lastCheckInAt has passed. One schedule per
    //   profile (columns, not a child table). consecutiveFailures drives auto-pause (SCHEDULE_MAX_FAILURES).
    scheduleEnabled: boolean('schedule_enabled').notNull().default(false),
    scheduleProjectId: text('schedule_project_id').references(() => projects.id, { onDelete: 'set null' }),
    scheduleIntervalSec: integer('schedule_interval_sec'), // interval mode (null when using cron)
    scheduleCron: text('schedule_cron'), // optional cron expression; overrides interval when set
    // IANA zone (e.g. 'America/New_York') the cron is evaluated in. null = the evaluating process's local
    // time — which differs between the launchd daemon (often UTC) and the web server, so a cron fires at an
    // unexpected hour. Set it to make the fire time deterministic; the DB row is the single source both the
    // scheduler and the web "next run" display read, so they can't disagree. Ignored in interval mode.
    scheduleTimezone: text('schedule_timezone'),
    checkInPrompt: text('check_in_prompt'), // the standing-mission prompt
    lastCheckInAt: timestamp('last_check_in_at', { withTimezone: true }), // baseline for "due"; advanced on spawn
    consecutiveFailures: integer('consecutive_failures').notNull().default(0), // → auto-pause at the cap
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('agent_profiles_slug_uq').on(t.slug),
    // At most one default profile across the table: a partial unique index over only is_default=true rows.
    uniqueIndex('agent_profiles_default_uq').on(t.isDefault).where(sql`is_default`),
    // The scheduler scans enabled + schedule_enabled rows each tick.
    index('agent_profiles_schedulable_idx').on(t.scheduleEnabled).where(sql`schedule_enabled`),
  ],
);

// ── Runs (agent sessions / executions) ──────────────────────────────────────────
// One unit of agent work. Agent identity is a free-text label (normalized `agents`
// table deferred). `id` is client-supplied by the hook so a retried run.start upserts.
export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    agentLabel: text('agent_label').notNull(),
    parentRunId: text('parent_run_id').references((): AnyPgColumn => runs.id, {
      onDelete: 'set null',
    }), // sub-agent trees
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    // Which profile this run used. Written by `mc run start --profile` now; by the daemon in Slice 2.
    // SET NULL so deleting a profile leaves historical runs intact (the linkage just drops).
    agentProfileId: text('agent_profile_id').references(() => agentProfiles.id, { onDelete: 'set null' }),
    title: text('title'),
    status: text('status').notNull().default('running'), // RUN_STATUSES; live/idle derived from lastHeartbeatAt
    source: text('source').notNull().default('hook'), // RUN_SOURCES
    model: text('model'),
    // Absolute cumulative totals, last-write-wins under a GREATEST() guard (idempotent under retry).
    // Cache tokens split out because they dominate Claude cost. Cost in micro-dollars. bigint, NOT int4:
    // these accumulate over a run, so a long unattended session would overflow int4's ~2.1B ceiling — and
    // costMicros caps soonest, at ~$2,147/run. mode:'number' keeps JS-number arithmetic (exact to 2^53,
    // far above any real token/cost value), so greatest()/formatCost and every reader stay unchanged.
    tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
    tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    sessionId: text('session_id'), // Claude Code's session_id (distinct from our id)
    workDir: text('work_dir'), // the hook's cwd
    transcriptRef: text('transcript_ref'), // path to on-disk transcript — never the body
    cancelRequested: boolean('cancel_requested').notNull().default(false), // kill-switch request flag — write: setRunCancelRequested; surfaced on heartbeat responses + enforced by the PreToolUse hook (PR #22) when installed
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('runs_status_heartbeat_idx').on(t.status, t.lastHeartbeatAt), // the reaper's index
    index('runs_agent_idx').on(t.agentLabel),
    index('runs_parent_idx').on(t.parentRunId),
  ],
);

// ── Events (append-only audit log) ──────────────────────────────────────────────
// Best-effort, never atomic with state (neon-http has no transactions). Optional FKs
// SET NULL so the log outlives the entities it references.
export const events = pgTable(
  'events',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    // bigint identity, mode:'number' to avoid Drizzle's bigint→string footgun (would lexically mis-sort the feed).
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    actorLabel: text('actor_label').notNull(), // who acted (free-text); distinct from subject runId
    type: text('type').notNull(), // EVENT_TYPES
    level: text('level').notNull().default('info'), // EVENT_LEVELS
    summary: text('summary').notNull(),
    payload: jsonb('payload'),
    tokens: bigint('tokens', { mode: 'number' }), // per-event attribution only (never the rollup source); bigint to match runs
    costMicros: bigint('cost_micros', { mode: 'number' }),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('events_order_idx').on(t.createdAt, t.seq), // replay / feed ordering
    index('events_project_idx').on(t.projectId),
    index('events_run_idx').on(t.runId),
    uniqueIndex('events_idempotency_uq')
      .on(t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`), // dedupe retried appends
  ],
);

// ── Composio connections (Integrations reshape) ───────────────────────────────────
// Per-toolkit shared Composio resources (auth-config + MCP server) created once and cached here.
export const composioToolkits = pgTable('composio_toolkits', {
  slug: text('slug').primaryKey(), // matches a COMPOSIO_CATALOG key
  authConfigId: text('auth_config_id'), // Composio ac_… (created once)
  mcpServerId: text('mcp_server_id'), // Composio MCP server id (created once)
  mcpUrl: text('mcp_url'), // base, e.g. https://backend.composio.dev/v3/mcp/<id>
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// The closed set of values the connection status column holds. mapStatus() is the single writer of
// derived values; the connect flow also writes 'initializing'/'disconnected' directly.
export type ConnectionStatus = 'initializing' | 'active' | 'error' | 'expired' | 'disconnected';

// One connection per (project, toolkit). Holds only Composio resource IDs — never a secret.
export const composioConnections = pgTable(
  'composio_connections',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // References a COMPOSIO_CATALOG key (the code catalog is the authority for valid toolkits) —
    // intentionally NOT a FK to composio_toolkits.slug: that table is a lazily-populated resource
    // CACHE, and a connection is "for the linear toolkit" independent of whether the cache row
    // exists yet. Orchestration validates the slug via getCatalogEntry + ensures the cache row
    // (ensure-before-connect) before any connection is written.
    toolkitSlug: text('toolkit_slug').notNull(),
    userId: text('user_id').notNull(), // mc-proj-<projectId> — the Composio user_id
    connectedAccountId: text('connected_account_id'), // Composio ca_… (set once link initiated)
    status: text('status').$type<ConnectionStatus>().notNull().default('initializing'),
    linkUrl: text('link_url'), // transient hosted link for an in-flight connect
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // INTENTIONAL single-account invariant: one connection per (project, toolkit). Multiple accounts
    // per project+toolkit is an explicit NON-GOAL for this single-user tool — the agent-facing MCP URL
    // routes by a per-PROJECT user_id (deriveUserId = mc-proj-<projectId>) and the mcpServers key is
    // per-toolkit (composioServerKey), so two same-toolkit accounts can't be independently routed without
    // a per-connection user_id rework. Do NOT drop this index to "allow multiple" without that redesign.
    uniqueIndex('composio_connections_project_toolkit_uq').on(t.projectId, t.toolkitSlug),
    index('composio_connections_project_idx').on(t.projectId),
  ],
);

export type ComposioToolkit = typeof composioToolkits.$inferSelect;
export type ComposioConnection = typeof composioConnections.$inferSelect;

// ── Settings (key/value) ───────────────────────────────────────────────────────
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── BetterAuth tables ───────────────────────────────────────────────────────--
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
});

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verificationTokens = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type AgentProfile = typeof agentProfiles.$inferSelect;
export type NewAgentProfile = typeof agentProfiles.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

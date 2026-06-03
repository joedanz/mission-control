// ABOUTME: Agent/operator CLI for Mission Control. Thin layer over lib/mutations + lib/queries.
// ABOUTME: JSON envelope on stdout (default when non-TTY), strict validation, scoped-role DB access.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import {
  CATEGORIES,
  STATUSES,
  ACCENTS,
  PRIORITIES,
  TASK_STATUSES,
  INTEGRATION_TYPES,
  INTEGRATION_STATUSES,
  RUN_STATUSES,
  RUN_SOURCES,
  EVENT_TYPES,
  EVENT_LEVELS,
  PROFILE_RUNTIMES,
  PERMISSION_MODES,
} from '../lib/db/schema';
import { assertEnum, ValidationError, NotFoundError, ConflictError } from '../lib/validation';
import { SPEND_GROUP_BYS, SCHEDULE_MIN_INTERVAL_SEC } from '../lib/constants';
import { parseGitHubRepo, listIssues, GitHubError } from '../lib/github';
import { statusLabel, isTaskDone, taskState } from '../lib/ui';
import { withActor } from '../lib/actor-context';
import { scanForLeakedSecrets, type ProfileInput, type ProfileUpdate, type MatchContext } from '../lib/profiles';
import { ensureDbCredentials, ConfigError } from './env';
import type { ProjectWithTasks } from '../lib/queries';
import type { Category, Project, Task, AgentProfile } from '../lib/db/schema';
import type { ProjectInput, ProjectUpdate } from '../lib/mutations';

// ── Output / envelope ───────────────────────────────────────────────────────--

type LeafOpts = { json?: boolean; human?: boolean } & Record<string, unknown>;

function isJson(opts: LeafOpts): boolean {
  if (opts.json) return true;
  if (opts.human) return false;
  return !process.stdout.isTTY; // agents pipe → JSON by default
}

/** Strip any connection string from a message before it ever reaches output/logs. */
function redact(msg: string): string {
  return msg.replace(/postgres(?:ql)?:\/\/[^\s"']*/gi, 'postgres://<redacted>');
}

type ErrInfo = { code: string; message: string; field?: string; exit: number };

function classify(err: unknown): ErrInfo {
  if (err instanceof ValidationError) {
    return { code: 'VALIDATION', message: err.message, field: err.field, exit: 2 };
  }
  if (err instanceof NotFoundError) {
    return { code: 'NOT_FOUND', message: err.message, exit: 3 };
  }
  if (err instanceof ConfigError) {
    return { code: 'CONFIG', message: err.message, exit: 4 };
  }
  if (err instanceof ConflictError) {
    return { code: 'CONFLICT', message: err.message, exit: 1 };
  }
  if (err instanceof GitHubError) {
    return { code: 'GITHUB', message: redact(err.message), exit: 1 };
  }
  // Postgres unique violation (e.g. duplicate slug, duplicate integration row).
  const e = err as { code?: string; sourceError?: { code?: string }; message?: string };
  const pg = e?.code ?? e?.sourceError?.code;
  const msg = e?.message ?? String(err);
  if (pg === '23505' || /\b23505\b/.test(msg)) {
    return { code: 'CONFLICT', message: redact(msg), exit: 1 };
  }
  return { code: 'DB', message: redact(msg), exit: 1 };
}

/** Run a command body, emitting a consistent envelope (stdout) or human text. */
async function emit(
  command: string,
  opts: LeafOpts,
  producer: () => Promise<{ data: unknown; human: () => void }>,
): Promise<void> {
  try {
    const { data, human } = await producer();
    if (isJson(opts)) {
      process.stdout.write(JSON.stringify({ ok: true, command, data }) + '\n');
    } else {
      human();
    }
    process.exitCode = 0;
  } catch (err) {
    const info = classify(err);
    if (isJson(opts)) {
      const error: Record<string, unknown> = { code: info.code, message: info.message };
      if (info.field) error.field = info.field;
      process.stdout.write(JSON.stringify({ ok: false, command, error }) + '\n');
    } else {
      process.stderr.write(`Error [${info.code}] ${info.message}\n`);
    }
    process.exitCode = info.exit;
  }
}

// ── DB loading (after credential resolution) ──────────────────────────────────-

async function loadDb() {
  ensureDbCredentials(); // throws ConfigError; must run before importing lib/db
  const [mutations, queries] = await Promise.all([
    import('../lib/mutations'),
    import('../lib/queries'),
  ]);
  return { mutations, queries };
}

type Queries = Awaited<ReturnType<typeof loadDb>>['queries'];

const NO_SLUG_HINT = "run 'mc project list --json' to see valid slugs";

/** Full project + tasks (for read commands that render the task list). */
async function resolveProject(queries: Queries, slug: string): Promise<ProjectWithTasks> {
  const p = await queries.getProjectBySlug(slug);
  if (!p) throw new NotFoundError('project', slug, NO_SLUG_HINT);
  return p;
}

/** Just the id (for mutation commands that don't need the task list). */
async function resolveProjectId(queries: Queries, slug: string): Promise<string> {
  const id = await queries.getProjectIdBySlug(slug);
  if (!id) throw new NotFoundError('project', slug, NO_SLUG_HINT);
  return id;
}

/** Coerce a raw CLI options bag into validated project fields. Only keys actually present in
 *  `opts` are returned, so this drives both `add` (createProject fills defaults) and the
 *  partial `update`. Invalid enums throw ValidationError (the CLI's strict policy). */
function coerceProjectFields(opts: LeafOpts): ProjectUpdate {
  const out: ProjectUpdate = {};
  if (opts.name !== undefined) out.name = String(opts.name);
  if (opts.category !== undefined) out.category = assertEnum(String(opts.category), CATEGORIES, 'category');
  if (opts.status !== undefined) out.status = assertEnum(String(opts.status), STATUSES, 'status');
  if (opts.accent !== undefined) out.accent = assertEnum(String(opts.accent), ACCENTS, 'accent');
  if (opts.domain !== undefined) out.domain = String(opts.domain) || null;
  if (opts.tech !== undefined) out.techStack = String(opts.tech).split(',').map((s) => s.trim()).filter(Boolean);
  if (opts.repoPath !== undefined) out.repoPath = String(opts.repoPath) || null;
  if (opts.repoUrl !== undefined) out.repoUrl = String(opts.repoUrl) || null;
  if (opts.liveUrl !== undefined) out.liveUrl = String(opts.liveUrl) || null;
  if (opts.sentryProject !== undefined) out.sentryProjectSlug = String(opts.sentryProject) || null;
  if (opts.emailProvider !== undefined) out.emailProvider = String(opts.emailProvider) || null;
  if (opts.emailAddress !== undefined) out.emailAddress = String(opts.emailAddress) || null;
  if (opts.stripeSite !== undefined) out.stripeSite = String(opts.stripeSite) || null;
  if (opts.priority !== undefined) out.priority = opts.priority ? assertEnum(String(opts.priority), PRIORITIES, 'priority') : null;
  if (opts.notes !== undefined) out.notes = String(opts.notes) || null;
  return out;
}

// ── Profile coercion ──────────────────────────────────────────────────────────--

const csv = (v: unknown): string[] => String(v).split(',').map((s) => s.trim()).filter(Boolean);
/** Repeatable-option collector for commander (`--env K=V --env K2=V2`). */
const collect = (val: string, prev: string[]): string[] => [...prev, val];

/** Parse `--mcp-config` (inline JSON or `@path`) into the canonical inner map. Accepts either the full
 *  `{ "mcpServers": { … } }` wrapper or the bare map; throws ValidationError on bad JSON / missing file. */
function parseMcpConfig(raw: string): Record<string, unknown> {
  let text = raw;
  if (raw.startsWith('@')) {
    try {
      text = readFileSync(raw.slice(1), 'utf8');
    } catch (e) {
      throw new ValidationError('mcp-config', `Cannot read ${raw.slice(1)}: ${(e as Error).message}`);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError('mcp-config', 'Invalid JSON (use inline JSON or @path/to/file.json)');
  }
  const obj = parsed as { mcpServers?: Record<string, unknown> };
  return (obj && typeof obj === 'object' && obj.mcpServers ? obj.mcpServers : (parsed as Record<string, unknown>));
}

/** Build validated profile fields from a raw options bag. Only keys actually present are returned, so it
 *  drives both `add` (createProfile fills defaults) and the partial `update`. Enum validation is strict;
 *  match-* flags assemble matchRules; --env collects KEY=VALUE pairs. Deep validation (mcp shape, regex,
 *  exec-template-required) happens in the mutation's validateProfile so web/CLI/tests share it. */
function coerceProfileFields(opts: LeafOpts): ProfileUpdate {
  const out: ProfileUpdate = {};
  if (opts.slug !== undefined) out.slug = String(opts.slug);
  if (opts.name !== undefined) out.name = String(opts.name);
  if (opts.description !== undefined) out.description = String(opts.description) || null;
  if (opts.runtime !== undefined) out.runtime = assertEnum(String(opts.runtime), PROFILE_RUNTIMES, 'runtime');
  if (opts.model !== undefined) out.model = String(opts.model) || null;
  if (opts.fallbackModel !== undefined) out.fallbackModel = String(opts.fallbackModel) || null;
  if (opts.dailyBudgetMicros !== undefined) {
    const v = String(opts.dailyBudgetMicros);
    if (v === '') out.dailyBudgetMicros = null;
    else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new ValidationError('dailyBudgetMicros', `Invalid --daily-budget-micros "${v}" — must be a non-negative integer (micro-dollars)`);
      out.dailyBudgetMicros = n;
    }
  }
  if (opts.provider !== undefined) out.provider = String(opts.provider) || null;
  if (opts.baseUrl !== undefined) out.baseUrl = String(opts.baseUrl) || null;
  if (opts.permissionMode !== undefined)
    out.permissionMode = opts.permissionMode ? assertEnum(String(opts.permissionMode), PERMISSION_MODES, 'permissionMode') : null;
  if (opts.skills !== undefined) out.skills = csv(opts.skills);
  if (opts.allowedTools !== undefined) out.allowedTools = csv(opts.allowedTools);
  if (opts.disallowedTools !== undefined) out.disallowedTools = csv(opts.disallowedTools);
  if (opts.appendSystemPrompt !== undefined) out.appendSystemPrompt = String(opts.appendSystemPrompt) || null;
  if (opts.execTemplate !== undefined) out.execTemplate = String(opts.execTemplate) || null;
  if (opts.mcpConfig !== undefined) out.mcpServers = parseMcpConfig(String(opts.mcpConfig)) as ProfileUpdate['mcpServers'];
  if (Array.isArray(opts.env) && opts.env.length) {
    out.env = Object.fromEntries(
      (opts.env as string[]).map((kv) => {
        const i = kv.indexOf('=');
        if (i < 0) throw new ValidationError('env', `Invalid --env "${kv}" — expected KEY=VALUE`);
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
    );
  }
  // Auto-routing rules: assemble from whatever match-* flags are present (each present flag replaces that
  // dimension). Categories are validated against the project category enum so a typo fails fast.
  const rules: Record<string, unknown> = {};
  if (opts.matchProject !== undefined) rules.projectSlugs = csv(opts.matchProject);
  if (opts.matchCategory !== undefined) rules.projectCategories = csv(opts.matchCategory).map((c) => assertEnum(c, CATEGORIES, 'match-category'));
  if (opts.matchKind !== undefined) rules.taskKinds = csv(opts.matchKind);
  if (opts.matchLabel !== undefined) rules.labelPattern = String(opts.matchLabel);
  if (Object.keys(rules).length) out.matchRules = rules as ProfileUpdate['matchRules'];
  if (opts.priority !== undefined) {
    const n = Number(opts.priority);
    if (!Number.isInteger(n)) throw new ValidationError('priority', `Invalid priority "${opts.priority}" — must be an integer`);
    out.priority = n;
  }
  if (opts.default) out.isDefault = true;
  if (opts.disabled) out.enabled = false;
  else if (opts.enabled) out.enabled = true;
  // Scheduled check-ins. --schedule-project is a slug → resolved to an id in the action handler (needs DB),
  // not here (this stays pure). The rest map directly; "" clears the interval/cron trigger.
  if (opts.scheduleEnabled) out.scheduleEnabled = true;
  else if (opts.scheduleDisabled) out.scheduleEnabled = false;
  if (opts.scheduleInterval !== undefined) {
    const v = String(opts.scheduleInterval);
    if (v === '') out.scheduleIntervalSec = null;
    else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < SCHEDULE_MIN_INTERVAL_SEC) throw new ValidationError('schedule-interval', `Invalid --schedule-interval "${v}" — must be an integer ≥ ${SCHEDULE_MIN_INTERVAL_SEC} (seconds)`);
      out.scheduleIntervalSec = n;
    }
  }
  if (opts.scheduleCron !== undefined) out.scheduleCron = String(opts.scheduleCron) || null;
  if (opts.scheduleTimezone !== undefined) out.scheduleTimezone = String(opts.scheduleTimezone) || null;
  if (opts.checkInPrompt !== undefined) out.checkInPrompt = readTextArg(String(opts.checkInPrompt)) || null;
  return out;
}

/** Read a `text|@file` argument: an `@path` prefix loads the file, anything else is the literal text. */
function readTextArg(raw: string): string {
  if (!raw.startsWith('@')) return raw;
  try {
    return readFileSync(raw.slice(1), 'utf8');
  } catch (e) {
    throw new ValidationError('check-in-prompt', `Cannot read ${raw.slice(1)}: ${(e as Error).message}`);
  }
}

// ── Human renderers ───────────────────────────────────────────────────────────

function printProfileLine(p: AgentProfile): void {
  const flags = `${p.isDefault ? 'D' : ' '}${p.enabled ? ' ' : 'x'}`;
  console.log(`${flags} ${p.slug.padEnd(22)} ${p.runtime.padEnd(11)} ${(p.model ?? '—').padEnd(16)} ${p.name}`);
}

function printProjectLine(p: Project): void {
  console.log(
    `${p.slug.padEnd(22)} ${p.category.padEnd(12)} ${statusLabel(p.status).padEnd(11)} ${p.name}`,
  );
}

function printTaskLine(t: Task): void {
  const done = isTaskDone(t) ? '✓' : ' ';
  console.log(`  [${done}] ${taskState(t).padEnd(11)} ${t.label}${t.integrationType ? ` (${t.integrationType})` : ''}`);
}

// ── Static catalogs (no DB) ────────────────────────────────────────────────────

const ENUMS = {
  category: CATEGORIES,
  status: STATUSES,
  accent: ACCENTS,
  priority: PRIORITIES,
  taskStatus: TASK_STATUSES,
  integrationType: INTEGRATION_TYPES,
  integrationStatus: INTEGRATION_STATUSES,
  runStatus: RUN_STATUSES,
  runSource: RUN_SOURCES,
  eventType: EVENT_TYPES,
  eventLevel: EVENT_LEVELS,
  runtime: PROFILE_RUNTIMES,
  permissionMode: PERMISSION_MODES,
} as const;

const SPEC = [
  { name: 'spec', readonly: true, summary: 'Machine-readable catalog of all commands + enums' },
  { name: 'enums', readonly: true, summary: 'Valid values for every enum field' },
  { name: 'project list', readonly: true, summary: 'List projects', options: ['--category', '--status', '--archived active|archived|all', '--search', '--limit'] },
  { name: 'project get', readonly: true, summary: 'Get a project + its tasks', args: ['<slug>'] },
  { name: 'project add', readonly: false, summary: 'Create a project', required: ['--name', '--category'], options: ['--status', '--accent', '--domain', '--tech', '--repo-path', '--repo-url', '--live-url', '--priority', '--notes', '--sentry-project', '--email-provider', '--email-address', '--stripe-site'] },
  { name: 'project update', readonly: false, summary: 'Update a project (only provided flags change)', args: ['<slug>'], options: ['--name', '--category', '--status', '--accent', '--domain', '--tech', '--repo-path', '--repo-url', '--live-url', '--priority', '--notes', '--sentry-project', '--email-provider', '--email-address', '--stripe-site'] },
  { name: 'project rm', readonly: false, summary: 'Delete a project (cascades tasks); requires --yes', args: ['<slug>'], required: ['--yes'] },
  { name: 'project set-repo', readonly: false, summary: 'Set a project repo path + url', args: ['<slug>', '<path>', '[url]'] },
  { name: 'task list', readonly: true, summary: "List a project's tasks", args: ['<slug>'], options: ['--status', '--kind custom|integration'] },
  { name: 'task get', readonly: true, summary: 'Get a single task by id', args: ['<id>'] },
  { name: 'task add', readonly: false, summary: 'Add a custom task', args: ['<slug>', '<label...>'] },
  { name: 'task set-status', readonly: false, summary: 'Set a task status (idempotent)', args: ['<id>', '<status>'] },
  { name: 'task move', readonly: false, summary: 'Move a task on the board: change status and/or reorder within a column', args: ['<id>'], options: ['--status', '--top', '--after'] },
  { name: 'task toggle', readonly: false, summary: 'Toggle a task done/undone', args: ['<id>'] },
  { name: 'task rm', readonly: false, summary: 'Delete a task; requires --yes', args: ['<id>'], required: ['--yes'] },
  { name: 'task next', readonly: true, summary: 'Show the next claimable task (FIFO: custom, todo, unclaimed/expired)', options: ['--project'] },
  { name: 'task claim', readonly: false, summary: 'Claim a task for the current run (single-statement, race-safe)', args: ['<id>'], options: ['--run', '--ttl'] },
  { name: 'task import-issues', readonly: false, summary: "Import a project's GitHub issues as custom tasks (idempotent by issue #)", args: ['<slug>'], options: ['--state open|closed|all', '--label', '--limit', '--dry-run'] },
  { name: 'integration set', readonly: false, summary: 'Upsert an integration status (idempotent)', args: ['<slug>', '<type>', '<status>'] },
  { name: 'integration list', readonly: true, summary: "List a project's integrations", args: ['<slug>'] },
  { name: 'composio catalog', readonly: true, summary: 'List supported Composio toolkits' },
  { name: 'composio connect', readonly: false, summary: 'Start a Composio connection (prints authorize link)', args: ['<slug>', '<toolkit>'] },
  { name: 'composio status', readonly: false, summary: 'Poll a Composio connection status', args: ['<slug>', '<toolkit>'] },
  { name: 'composio list', readonly: true, summary: "List a project's Composio connections", args: ['<slug>'] },
  { name: 'composio disconnect', readonly: false, summary: 'Disconnect a Composio toolkit', args: ['<slug>', '<toolkit>'] },
  { name: 'profile list', readonly: true, summary: 'List agent profiles', options: ['--enabled', '--runtime claude-code|exec', '--schedulable'] },
  { name: 'profile get', readonly: true, summary: 'Get one agent profile by slug', args: ['<slug>'] },
  { name: 'profile add', readonly: false, summary: 'Create an agent profile', required: ['--slug', '--name'], options: ['--description', '--runtime', '--model', '--fallback-model', '--daily-budget-micros', '--provider', '--base-url', '--permission-mode', '--skills', '--mcp-config', '--allowed-tools', '--disallowed-tools', '--append-system-prompt', '--env', '--exec-template', '--match-project', '--match-category', '--match-kind', '--match-label', '--priority', '--default', '--disabled', '--schedule-enabled', '--schedule-disabled', '--schedule-project', '--schedule-interval', '--schedule-cron', '--schedule-timezone', '--check-in-prompt'] },
  { name: 'profile update', readonly: false, summary: 'Update an agent profile (only provided flags change)', args: ['<slug>'], options: ['--name', '--description', '--runtime', '--model', '--fallback-model', '--daily-budget-micros', '--provider', '--base-url', '--permission-mode', '--skills', '--mcp-config', '--allowed-tools', '--disallowed-tools', '--append-system-prompt', '--env', '--exec-template', '--match-project', '--match-category', '--match-kind', '--match-label', '--priority', '--default', '--enabled', '--disabled', '--schedule-enabled', '--schedule-disabled', '--schedule-project', '--schedule-interval', '--schedule-cron', '--schedule-timezone', '--check-in-prompt'] },
  { name: 'profile set-default', readonly: false, summary: 'Make a profile the single global default (idempotent)', args: ['<slug>'] },
  { name: 'profile checked-in', readonly: false, summary: 'Record a scheduled check-in (advances clock; --status ok|fail tracks failures/auto-pause)', args: ['<slug>'], options: ['--status'] },
  { name: 'profile rm', readonly: false, summary: 'Delete an agent profile; requires --yes', args: ['<slug>'], required: ['--yes'] },
  { name: 'profile resolve', readonly: true, summary: 'Preview which profile auto-routing picks for a project/task', options: ['--project', '--task', '--label', '--kind'] },
  { name: 'run start', readonly: false, summary: 'Open an agent run (prints runId)', required: ['--agent'], options: ['--project', '--profile', '--title', '--source', '--model', '--session-id', '--work-dir', '--id'] },
  { name: 'run end', readonly: false, summary: 'Close a run with a terminal status', args: ['<id>', '<status>'], options: ['--tokens-in', '--tokens-out', '--cache-read', '--cache-write', '--cost-micros', '--authoritative', '--agent'] },
  { name: 'run list', readonly: true, summary: 'List recent runs (newest heartbeat first)', options: ['--active', '--agent', '--limit'] },
  { name: 'run get', readonly: true, summary: 'Show a run with its event trail', args: ['<id>'] },
  { name: 'run cancel', readonly: false, summary: 'Request cancellation of a running run (enforced by the PreToolUse kill-switch hook when installed)', args: ['<id>'] },
  { name: 'event add', readonly: false, summary: 'Append an event to the activity log', required: ['--type'], args: ['<summary...>'], options: ['--project', '--task', '--run', '--level', '--agent'] },
  { name: 'event list', readonly: true, summary: 'List recent events (newest first)', options: ['--project', '--run', '--level', '--limit'] },
  { name: 'spend', readonly: true, summary: 'Cost rollup over runs (grouped, windowed)', options: ['--group-by project|agent|day|run', '--since', '--until', '--project', '--agent', '--profile', '--limit'] },
] as const;

// ── Program ─────────────────────────────────────────────────────────────────--

let versionCache: string | undefined;
function getVersion(): string {
  if (versionCache !== undefined) return versionCache;
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    versionCache = (JSON.parse(readFileSync(pkgPath, 'utf8')).version as string) ?? '0.0.0-dev';
  } catch {
    versionCache = '0.0.0-dev';
  }
  return versionCache;
}

/** Adds the two output flags every command supports. */
function withFlags(cmd: Command): Command {
  return cmd.option('--json', 'machine-readable JSON output').option('--human', 'force human output');
}

const program = new Command();
program
  .name('mc')
  .description('Mission Control CLI — agent-friendly access to projects + tasks')
  .version(getVersion());

// ── meta (no DB) ──
withFlags(program.command('spec'))
  .description('Print the machine-readable command catalog')
  .action((opts: LeafOpts) =>
    emit('spec', opts, async () => ({
      data: { version: getVersion(), commands: SPEC, enums: ENUMS },
      human: () => SPEC.forEach((c) => console.log(`${c.readonly ? ' ' : '*'} ${c.name.padEnd(18)} ${c.summary}`)),
    })),
  );

withFlags(program.command('enums'))
  .description('Print valid values for every enum field')
  .action((opts: LeafOpts) =>
    emit('enums', opts, async () => ({
      data: ENUMS,
      human: () => Object.entries(ENUMS).forEach(([k, v]) => console.log(`${k.padEnd(18)} ${v.join(', ')}`)),
    })),
  );

// ── project ──
const project = program.command('project').description('Manage projects');

withFlags(project.command('list'))
  .description('List projects')
  .option('--category <category>', 'filter by category')
  .option('--status <status>', 'filter by status')
  .option('--archived <mode>', 'active | archived | all', 'active')
  .option('--search <query>', 'match name / slug / domain / tech')
  .option('--limit <n>', 'max rows returned', '50')
  .action((opts: LeafOpts) =>
    emit('project list', opts, async () => {
      const archived = assertEnum(String(opts.archived), ['active', 'archived', 'all'] as const, 'archived');
      if (opts.category) assertEnum(String(opts.category), CATEGORIES, 'category');
      if (opts.status) assertEnum(String(opts.status), STATUSES, 'status');
      const { queries } = await loadDb();
      let items = await queries.getProjectsWithTasks({ archived });
      if (opts.category) items = items.filter((p) => p.category === opts.category);
      if (opts.status) items = items.filter((p) => p.status === opts.status);
      if (opts.search) {
        const q = String(opts.search).toLowerCase();
        items = items.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.slug.toLowerCase().includes(q) ||
            (p.domain ?? '').toLowerCase().includes(q) ||
            p.techStack.some((t) => t.toLowerCase().includes(q)),
        );
      }
      const rank = (c: Category) => {
        const i = CATEGORIES.indexOf(c);
        return i < 0 ? CATEGORIES.length : i;
      };
      items.sort(
        (a, b) =>
          rank(a.category) - rank(b.category) ||
          a.sortOrder - b.sortOrder ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      );
      const count = items.length;
      const limit = Math.max(1, parseInt(String(opts.limit), 10) || 50);
      const limited = items.slice(0, limit);
      // strip nested tasks from list payload to keep it lean
      const rows = limited.map(({ tasks, ...p }) => p);
      return {
        data: { items: rows, count },
        human: () => {
          limited.forEach((p) => printProjectLine(p));
          console.log(`\n${limited.length} of ${count} projects`);
        },
      };
    }),
  );

withFlags(project.command('get'))
  .description('Get a project + its tasks')
  .argument('<slug>')
  .action((slug: string, opts: LeafOpts) =>
    emit('project get', opts, async () => {
      const { queries } = await loadDb();
      const p = await resolveProject(queries, slug);
      return {
        data: p,
        human: () => {
          console.log(`${p.name} (${p.slug}) — ${statusLabel(p.status)} — ${p.category}`);
          if (p.domain) console.log(`domain: ${p.domain}`);
          if (p.repoPath) console.log(`repo:   ${p.repoPath}`);
          console.log('tasks:');
          p.tasks.forEach((t) => printTaskLine(t));
        },
      };
    }),
  );

withFlags(project.command('add'))
  .description('Create a project')
  .requiredOption('--name <name>')
  .requiredOption('--category <category>', CATEGORIES.join(' | '))
  .option('--status <status>', STATUSES.join(' | '), 'prelaunch')
  .option('--accent <accent>', ACCENTS.join(' | '), 'orange')
  .option('--domain <domain>')
  .option('--tech <csv>', 'comma-separated tech stack')
  .option('--repo-path <path>')
  .option('--repo-url <url>')
  .option('--live-url <url>')
  .option('--sentry-project <slug>')
  .option('--email-provider <name>')
  .option('--email-address <addr>')
  .option('--stripe-site <id>')
  .option('--priority <priority>', PRIORITIES.join(' | '))
  .option('--notes <notes>')
  .action((opts: LeafOpts) =>
    emit('project add', opts, async () => {
      // --name/--category are requiredOptions and --status/--accent have defaults, so the
      // coerced bag always carries the fields ProjectInput needs; createProject fills the rest.
      const input = coerceProjectFields(opts) as ProjectInput;
      const { mutations } = await loadDb();
      const row = await mutations.createProject(input);
      return { data: row, human: () => console.log(`Created ${row.slug} (${row.id})`) };
    }),
  );

withFlags(project.command('update'))
  .description('Update a project (only provided flags change)')
  .argument('<slug>')
  .option('--name <name>')
  .option('--category <category>')
  .option('--status <status>')
  .option('--accent <accent>')
  .option('--domain <domain>')
  .option('--tech <csv>')
  .option('--repo-path <path>')
  .option('--repo-url <url>')
  .option('--live-url <url>')
  .option('--sentry-project <slug>')
  .option('--email-provider <name>')
  .option('--email-address <addr>')
  .option('--stripe-site <id>')
  .option('--priority <priority>')
  .option('--notes <notes>')
  .action((slug: string, opts: LeafOpts) =>
    emit('project update', opts, async () => {
      const update = coerceProjectFields(opts);
      const { mutations, queries } = await loadDb();
      const id = await resolveProjectId(queries, slug);
      const row = await mutations.updateProject(id, update);
      if (!row) throw new NotFoundError('project', slug);
      return { data: row, human: () => console.log(`Updated ${row.slug}`) };
    }),
  );

withFlags(project.command('rm'))
  .description('Delete a project (cascades tasks)')
  .argument('<slug>')
  .option('--yes', 'confirm destructive delete')
  .action((slug: string, opts: LeafOpts) =>
    emit('project rm', opts, async () => {
      if (!opts.yes) throw new ValidationError('yes', 'Refusing to delete without --yes');
      const { mutations, queries } = await loadDb();
      const id = await resolveProjectId(queries, slug);
      const result = await mutations.deleteProject(id);
      if (!result) throw new NotFoundError('project', slug);
      return {
        data: { project: result.project, deletedTaskCount: result.deletedTaskCount },
        human: () => console.log(`Deleted ${slug} (+${result.deletedTaskCount} tasks cascaded)`),
      };
    }),
  );

withFlags(project.command('set-repo'))
  .description('Set a project repo path + url')
  .argument('<slug>')
  .argument('<path>', 'absolute local repo path')
  .argument('[url]', 'remote repo URL')
  .action((slug: string, path: string, url: string | undefined, opts: LeafOpts) =>
    emit('project set-repo', opts, async () => {
      const { mutations, queries } = await loadDb();
      const id = await resolveProjectId(queries, slug);
      const row = await mutations.setProjectRepo(id, path || null, url ?? null);
      return { data: row, human: () => console.log(`${slug}: repo → ${path}${url ? ` (${url})` : ''}`) };
    }),
  );

// ── task ──
/** Build the destination column's new id ordering for `task move`. `columnIds` are the dest column's
 *  sibling ids in sortOrder (the moved id already excluded). `--top` puts the card first; `--after` puts
 *  it right after a named sibling (ValidationError if that sibling isn't in this column); neither returns
 *  undefined — a pure status change that leaves sort_order untouched. Pure (no DB) so it's unit-tested. */
export function planMoveOrder(
  columnIds: string[],
  movedId: string,
  placement: { top?: boolean; after?: string },
): string[] | undefined {
  if (placement.top) return [movedId, ...columnIds];
  if (placement.after !== undefined) {
    const idx = columnIds.indexOf(placement.after);
    if (idx < 0) {
      throw new ValidationError('after', `--after task ${placement.after} is not in the destination column`);
    }
    return [...columnIds.slice(0, idx + 1), movedId, ...columnIds.slice(idx + 1)];
  }
  return undefined;
}

const task = program.command('task').description('Manage tasks');

withFlags(task.command('list'))
  .description("List a project's tasks")
  .argument('<slug>')
  .option('--status <status>', 'filter custom-task status')
  .option('--kind <kind>', 'custom | integration')
  .action((slug: string, opts: LeafOpts) =>
    emit('task list', opts, async () => {
      if (opts.kind) assertEnum(String(opts.kind), ['custom', 'integration'] as const, 'kind');
      const { queries } = await loadDb();
      const p = await resolveProject(queries, slug);
      let items = p.tasks;
      if (opts.kind) items = items.filter((t) => t.kind === opts.kind);
      if (opts.status) items = items.filter((t) => t.status === opts.status);
      return {
        data: { items, count: items.length },
        human: () => {
          items.forEach((t) => printTaskLine(t));
          console.log(`\n${items.length} tasks`);
        },
      };
    }),
  );

withFlags(task.command('get'))
  .description('Get a single task by id')
  .argument('<id>')
  .action((id: string, opts: LeafOpts) =>
    emit('task get', opts, async () => {
      const { queries } = await loadDb();
      const t = await queries.getTaskById(id);
      if (!t) throw new NotFoundError('task', id);
      return { data: t, human: () => printTaskLine(t) };
    }),
  );

withFlags(task.command('add'))
  .description('Add a custom task')
  .argument('<slug>')
  .argument('<label...>')
  .action((slug: string, labelParts: string[], opts: LeafOpts) =>
    emit('task add', opts, async () => {
      const label = labelParts.join(' ').trim();
      if (!label) throw new ValidationError('label', 'Task label cannot be empty');
      const { mutations, queries } = await loadDb();
      const id = await resolveProjectId(queries, slug);
      const row = await mutations.addTask(id, label);
      return { data: row, human: () => console.log(`Added task ${row.id}: ${label}`) };
    }),
  );

withFlags(task.command('set-status'))
  .description('Set a task status (idempotent)')
  .argument('<id>')
  .argument('<status>', TASK_STATUSES.join(' | '))
  .action((id: string, status: string, opts: LeafOpts) =>
    emit('task set-status', opts, async () => {
      const s = assertEnum(status, TASK_STATUSES, 'status');
      const { mutations } = await loadDb();
      const row = await mutations.setTaskStatus(id, s);
      if (!row) throw new NotFoundError('task', id);
      return { data: row, human: () => console.log(`Task ${id} → ${s}`) };
    }),
  );

withFlags(task.command('move'))
  .description('Move a custom task on the board: change its status and/or reorder it within a column')
  .argument('<id>')
  .option('--status <status>', `move to a column: ${TASK_STATUSES.join(' | ')}`)
  .option('--top', 'place at the top of the destination column (claimed next)')
  .option('--after <id>', 'place immediately after this sibling in the destination column')
  .action((id: string, opts: LeafOpts) =>
    emit('task move', opts, async () => {
      if (opts.top && opts.after) throw new ValidationError('top', 'Use only one of --top or --after');
      if (!opts.status && !opts.top && !opts.after) {
        throw new ValidationError('status', 'Nothing to move: pass --status, --top, or --after');
      }
      const { mutations, queries } = await loadDb();
      // Read first so a null from moveTask means "couldn't move" (live claim), not "no such task".
      const current = await queries.getTaskById(id);
      if (!current) throw new NotFoundError('task', id);
      if (current.kind !== 'custom') {
        throw new ValidationError('id', `Only custom tasks live on the board (task ${id} is ${current.kind})`);
      }
      const toStatus = opts.status ? assertEnum(String(opts.status), TASK_STATUSES, 'status') : undefined;
      const destStatus = toStatus ?? current.status;
      // Destination column siblings in board order (the query sorts by sortOrder), moved id excluded.
      const columnIds = (await queries.getTasksByProjectId(current.projectId))
        .filter((t) => t.kind === 'custom' && t.status === destStatus && t.id !== id)
        .map((t) => t.id);
      const orderedIds = planMoveOrder(columnIds, id, {
        top: !!opts.top,
        after: opts.after ? String(opts.after) : undefined,
      });
      const row = await mutations.moveTask(id, { toStatus, orderedIds });
      if (!row) {
        // Existence was confirmed above, so a null is the live-claim refusal (or a status it raced into).
        throw new ConflictError(
          'task',
          `Task ${id} can't be moved — it's claimed by a live run (work isn't yanked out from under a running agent)`,
        );
      }
      const where = opts.top ? ' (top)' : opts.after ? ` (after ${String(opts.after).slice(0, 8)})` : '';
      return {
        data: row,
        human: () => console.log(`Moved "${row.label}"${toStatus ? ` → ${toStatus}` : ''}${where}`),
      };
    }),
  );

withFlags(task.command('toggle'))
  .description('Toggle a task done/undone')
  .argument('<id>')
  .action((id: string, opts: LeafOpts) =>
    emit('task toggle', opts, async () => {
      const { mutations } = await loadDb();
      const row = await mutations.toggleTask(id);
      if (!row) throw new NotFoundError('task', id);
      return { data: row, human: () => console.log(`${row.label}: ${taskState(row)}`) };
    }),
  );

withFlags(task.command('rm'))
  .description('Delete a task')
  .argument('<id>')
  .option('--yes', 'confirm destructive delete')
  .action((id: string, opts: LeafOpts) =>
    emit('task rm', opts, async () => {
      if (!opts.yes) throw new ValidationError('yes', 'Refusing to delete without --yes');
      const { mutations } = await loadDb();
      const row = await mutations.deleteTask(id);
      if (!row) throw new NotFoundError('task', id);
      return { data: row, human: () => console.log(`Deleted task ${id}`) };
    }),
  );

withFlags(task.command('next'))
  .description('Show the next claimable task (FIFO: custom, todo, unclaimed or claim-expired)')
  .option('--project <slug>', 'limit to a project')
  .action((opts: LeafOpts) =>
    emit('task next', opts, async () => {
      const { queries } = await loadDb();
      const projectId = opts.project ? await resolveProjectId(queries, String(opts.project)) : undefined;
      const t = await queries.getNextClaimableTask({ projectId });
      return {
        data: t,
        human: () => console.log(t ? `${t.id}  ${t.label}` : 'no claimable task'),
      };
    }),
  );

withFlags(task.command('claim'))
  .description('Claim a task for the current run (single-statement, race-safe; loses → CONFLICT)')
  .argument('<id>')
  .option('--run <id>', 'run id to claim under (default: CC_RUN_ID / the session run file)')
  .option('--ttl <seconds>', 'claim TTL in seconds (default: CLAIM_TTL_SEC)')
  .action((id: string, opts: LeafOpts) =>
    emit('task claim', opts, async () => {
      const { mutations } = await loadDb();
      const runId = opts.run ? String(opts.run) : resolveRunId();
      const row = await mutations.claimTask(id, runId, num(opts.ttl));
      if (!row) throw new NotFoundError('task', id);
      return {
        data: row,
        human: () => console.log(`Claimed "${row.label}"${runId ? ` (run ${runId.slice(0, 8)})` : ' (manual)'}`),
      };
    }),
  );

withFlags(task.command('import-issues'))
  .description("Import a project's GitHub issues as custom tasks (idempotent by issue number)")
  .argument('<slug>')
  .option('--state <state>', 'open | closed | all', 'open')
  .option('--label <name>', 'only issues carrying this GitHub label')
  .option('--limit <n>', 'max issues to fetch', '100')
  .option('--dry-run', 'list what would be imported without writing')
  .action((slug: string, opts: LeafOpts) =>
    emit('task import-issues', opts, async () => {
      const state = assertEnum(String(opts.state ?? 'open'), ['open', 'closed', 'all'] as const, 'state');
      const { mutations, queries } = await loadDb();
      const project = await resolveProject(queries, slug); // has repoUrl + existing tasks (for dedup)
      const repo = parseGitHubRepo(project.repoUrl);
      if (!repo) {
        throw new ValidationError(
          'repoUrl',
          `project "${slug}" has no GitHub repoUrl (got ${project.repoUrl ?? 'none'}) — set one with 'mc project set-repo'`,
        );
      }
      const issues = await listIssues(repo, {
        state,
        limit: num(opts.limit) ?? 100,
        label: opts.label ? String(opts.label) : undefined,
      });
      // Idempotent by issue NUMBER (survives renamed titles): skip issues already imported. Count ONLY
      // prior imports — identified by notes being the GitHub issue URL importTasks stored — so a human
      // task coincidentally labeled "#5 ..." can't suppress importing issue #5. onConflictDoNothing in
      // importTasks is the exact-label race backstop.
      const already = new Set<number>();
      for (const t of project.tasks) {
        if (!t.notes || !/^https?:\/\/github\.com\//i.test(t.notes)) continue;
        const m = /^#(\d+)\b/.exec(t.label);
        if (m) already.add(Number(m[1]));
      }
      const fresh = issues.filter((i) => !already.has(i.number));
      const items = fresh.map((i) => ({ label: `#${i.number} ${i.title}`.slice(0, 200), notes: i.url }));
      const repoLabel = `${repo.owner}/${repo.repo}`;

      if (opts.dryRun) {
        return {
          data: { repo: repoLabel, fetched: issues.length, new: items.length, dryRun: true, wouldImport: items.map((i) => i.label) },
          human: () => {
            console.log(`${repoLabel}: ${issues.length} issue(s), ${items.length} new (dry-run)`);
            items.forEach((i) => console.log(`  + ${i.label}`));
          },
        };
      }
      const created = await mutations.importTasks(project.id, items);
      return {
        data: { repo: repoLabel, fetched: issues.length, imported: created.length, skipped: issues.length - created.length, tasks: created },
        human: () => {
          console.log(`${repoLabel}: imported ${created.length} new task(s), ${issues.length - created.length} skipped`);
          created.forEach((t) => console.log(`  + ${t.id}  ${t.label}`));
        },
      };
    }),
  );

// ── integration ──
const integration = program.command('integration').description('Manage project integrations');

withFlags(integration.command('set'))
  .description('Upsert an integration status (idempotent)')
  .argument('<slug>')
  .argument('<type>', INTEGRATION_TYPES.join(' | '))
  .argument('<status>', INTEGRATION_STATUSES.join(' | '))
  .action((slug: string, type: string, status: string, opts: LeafOpts) =>
    emit('integration set', opts, async () => {
      const t = assertEnum(type, INTEGRATION_TYPES, 'type');
      const s = assertEnum(status, INTEGRATION_STATUSES, 'status');
      const { mutations, queries } = await loadDb();
      const id = await resolveProjectId(queries, slug);
      const row = await mutations.upsertIntegration(id, t, s);
      return { data: row, human: () => console.log(`${slug}: ${t} → ${s}`) };
    }),
  );

withFlags(integration.command('list'))
  .description("List a project's integrations")
  .argument('<slug>')
  .action((slug: string, opts: LeafOpts) =>
    emit('integration list', opts, async () => {
      const { queries } = await loadDb();
      const p = await resolveProject(queries, slug);
      const items = p.tasks.filter((t) => t.kind === 'integration');
      return {
        data: { items, count: items.length },
        human: () => {
          items.forEach((t) => printTaskLine(t));
          console.log(`\n${items.length} integrations`);
        },
      };
    }),
  );

// ── composio ──
const composio = program.command('composio').description('Manage Composio toolkit connections');

withFlags(composio.command('catalog'))
  .description('List supported Composio toolkits')
  .action((opts: LeafOpts) =>
    emit('composio catalog', opts, async () => {
      const { COMPOSIO_CATALOG } = await import('../lib/composio-catalog');
      const items = Object.entries(COMPOSIO_CATALOG).map(([slug, entry]) => ({
        slug,
        name: entry.name,
        tools: entry.allowedTools.length,
      }));
      return {
        data: { items, count: items.length },
        human: () => items.forEach((t) => console.log(`${t.slug}  ${t.name}  (${t.tools} tools)`)),
      };
    }),
  );

withFlags(composio.command('connect'))
  .description('Start a Composio connection (prints authorize link)')
  .argument('<slug>')
  .argument('<toolkit>')
  .action((slug: string, toolkit: string, opts: LeafOpts) =>
    emit('composio connect', opts, async () => {
      ensureDbCredentials();
      const { connectStart } = await import('../lib/composio-connections');
      const { linkUrl, connection } = await connectStart(slug, toolkit);
      return {
        data: { linkUrl, connection },
        human: () => {
          console.log(`Open to authorize:\n${linkUrl}`);
          console.log(`Then: mc composio status ${slug} ${toolkit}`);
        },
      };
    }),
  );

withFlags(composio.command('status'))
  .description('Poll a Composio connection status')
  .argument('<slug>')
  .argument('<toolkit>')
  .action((slug: string, toolkit: string, opts: LeafOpts) =>
    emit('composio status', opts, async () => {
      ensureDbCredentials();
      const { connectPoll } = await import('../lib/composio-connections');
      const connection = await connectPoll(slug, toolkit);
      return { data: connection, human: () => console.log(`${slug}/${toolkit}: ${connection.status}`) };
    }),
  );

withFlags(composio.command('list'))
  .description("List a project's Composio connections")
  .argument('<slug>')
  .action((slug: string, opts: LeafOpts) =>
    emit('composio list', opts, async () => {
      ensureDbCredentials();
      const { listConnections } = await import('../lib/composio-connections');
      const items = await listConnections(slug);
      return {
        data: { items, count: items.length },
        human: () => {
          items.forEach((c) => console.log(`${c.toolkitSlug}  ${c.status}`));
          console.log(`\n${items.length} connection${items.length === 1 ? '' : 's'}`);
        },
      };
    }),
  );

withFlags(composio.command('disconnect'))
  .description('Disconnect a Composio toolkit')
  .argument('<slug>')
  .argument('<toolkit>')
  .action((slug: string, toolkit: string, opts: LeafOpts) =>
    emit('composio disconnect', opts, async () => {
      ensureDbCredentials();
      const { disconnect } = await import('../lib/composio-connections');
      const connection = await disconnect(slug, toolkit);
      return { data: connection, human: () => console.log(`${slug}/${toolkit}: ${connection.status}`) };
    }),
  );

// ── run + event helpers ─────────────────────────────────────────────────────--

/** Default actor label for run/event commands: --agent, else $MC_AGENT, else 'mc'. */
function actorLabel(opts: LeafOpts): string {
  return String(opts.agent ?? process.env.MC_AGENT ?? 'mc');
}

function num(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse an ISO date/datetime flag → Date, throwing VALIDATION (exit 2) with an actionable message
 *  on garbage. A zoneless date/datetime is read as UTC (the dashboard's canonical zone, matching the
 *  UTC day buckets) rather than the host's local time, so `--since`/`--until` windows are reproducible. */
function parseDate(v: unknown, field: string): Date {
  const s = String(v).trim();
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  const iso = hasZone ? s : s.length <= 10 ? `${s}T00:00:00Z` : `${s}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(field, `Invalid ${field} "${v}" — use an ISO date like 2026-05-01 (UTC) or 2026-05-01T12:00:00Z`);
  }
  return d;
}

/** Micro-dollars → a 4dp USD string for human CLI output (agent-facing precision; the web uses 2dp). */
function usdMicros(m: number): string {
  return `$${(m / 1e6).toFixed(4)}`;
}

function metricsFrom(opts: LeafOpts) {
  return {
    tokensIn: num(opts.tokensIn),
    tokensOut: num(opts.tokensOut),
    cacheReadTokens: num(opts.cacheRead),
    cacheWriteTokens: num(opts.cacheWrite),
    costMicros: num(opts.costMicros),
  };
}

// ── run ──
// ── profile ──
const profile = program.command('profile').description('Manage agent profiles');

const NO_PROFILE_HINT = "run 'mc profile list --json' to see valid slugs";
async function resolveProfileSlug(queries: Queries, slug: string): Promise<AgentProfile> {
  const p = await queries.getProfileBySlug(slug);
  if (!p) throw new NotFoundError('profile', slug, NO_PROFILE_HINT);
  return p;
}

/** Resolve `--schedule-project <slug>` → `scheduleProjectId` on the input (needs the DB, so it can't live
 *  in the pure coerceProfileFields). Pass "" to clear the binding. No-op when the flag is absent. */
async function applyScheduleProject(input: ProfileUpdate, opts: LeafOpts, queries: Queries): Promise<void> {
  if (opts.scheduleProject === undefined) return;
  const raw = String(opts.scheduleProject);
  input.scheduleProjectId = raw === '' ? null : (await resolveProject(queries, raw)).id;
}

/** Shared option set for `profile add` + `profile update` (add makes --slug/--name required separately). */
function profileFieldOptions(cmd: Command): Command {
  return cmd
    .option('--description <text>')
    .option('--runtime <r>', PROFILE_RUNTIMES.join(' | '))
    .option('--model <model>', 'e.g. opus, claude-sonnet-4-6, gpt-4o')
    .option('--fallback-model <model>', "claude's --fallback-model (overload resilience) + the budget-downgrade target")
    .option('--daily-budget-micros <n>', 'micro-dollar/day cap; once exceeded the daemon downgrades to --fallback-model')
    .option('--provider <provider>', 'anthropic | openai | litellm | …')
    .option('--base-url <url>', 'gateway/provider endpoint')
    .option('--permission-mode <mode>', PERMISSION_MODES.join(' | '))
    .option('--skills <csv>', 'comma-separated skill names')
    .option('--mcp-config <json|@file>', 'MCP servers JSON (inline or @path); ${ENV} placeholders only')
    .option('--allowed-tools <csv>')
    .option('--disallowed-tools <csv>')
    .option('--append-system-prompt <text>', 'persona appended to the system prompt')
    .option('--env <kv>', 'repeatable KEY=VALUE (use ${ENV} for secrets)', collect, [])
    .option('--exec-template <cmd>', "command template for runtime 'exec'")
    .option('--match-project <csv>', 'route tasks of these project slugs here')
    .option('--match-category <csv>', `${CATEGORIES.join(' | ')}`)
    .option('--match-kind <csv>', 'custom | integration')
    .option('--match-label <regex>', 'route tasks whose label matches this regex')
    .option('--priority <n>', 'routing tie-break (higher wins)')
    // Scheduled check-ins (Slice 5): a profile wakes on its own schedule and runs a standing mission in
    // --schedule-project's repo. Pass "" to --schedule-interval / --schedule-cron to clear that trigger.
    .option('--schedule-enabled', 'turn on scheduled check-ins (needs --schedule-project + one trigger)')
    .option('--schedule-disabled', 'turn off scheduled check-ins')
    .option('--schedule-project <slug>', 'project the check-in runs in (its repo = cwd, its queue = scope)')
    .option('--schedule-interval <sec>', `check in every N seconds (min ${SCHEDULE_MIN_INTERVAL_SEC})`)
    .option('--schedule-cron <expr>', 'cron schedule (overrides --schedule-interval); evaluated in --schedule-timezone')
    .option('--schedule-timezone <tz>', 'IANA zone for --schedule-cron (e.g. America/New_York); default: daemon local time')
    .option('--check-in-prompt <text|@file>', 'the standing-mission prompt for each check-in');
}

withFlags(profile.command('list'))
  .description('List agent profiles')
  .option('--enabled', 'only enabled profiles')
  .option('--runtime <r>', PROFILE_RUNTIMES.join(' | '))
  .option('--schedulable', 'only profiles with scheduled check-ins enabled (the scheduler scan)')
  .action((opts: LeafOpts) =>
    emit('profile list', opts, async () => {
      const { queries } = await loadDb();
      const items = await queries.getProfiles({
        // --schedulable implies the profile must also be globally enabled (a disabled profile never runs).
        enabled: opts.schedulable || opts.enabled ? true : undefined,
        runtime: opts.runtime ? assertEnum(String(opts.runtime), PROFILE_RUNTIMES, 'runtime') : undefined,
        scheduleEnabled: opts.schedulable ? true : undefined,
      });
      return { data: { items, count: items.length }, human: () => items.forEach(printProfileLine) };
    }),
  );

withFlags(profile.command('get'))
  .description('Get one agent profile by slug')
  .argument('<slug>')
  .action((slug: string, opts: LeafOpts) =>
    emit('profile get', opts, async () => {
      const { queries } = await loadDb();
      const p = await resolveProfileSlug(queries, slug);
      return { data: p, human: () => console.log(JSON.stringify(p, null, 2)) };
    }),
  );

profileFieldOptions(withFlags(profile.command('add')))
  .description('Create an agent profile')
  .requiredOption('--slug <slug>')
  .requiredOption('--name <name>')
  .option('--default', 'make this the global default')
  .option('--disabled', 'create disabled')
  .action((opts: LeafOpts) =>
    emit('profile add', opts, async () => {
      const input = coerceProfileFields(opts) as ProfileInput;
      const { mutations, queries } = await loadDb();
      await applyScheduleProject(input, opts, queries);
      const row = await mutations.createProfile(input);
      const warnings = scanForLeakedSecrets(row);
      warnings.forEach((w) => process.stderr.write(`Warning: ${w}\n`));
      return {
        data: warnings.length ? { ...row, warnings } : row,
        human: () => console.log(`Created ${row.slug} (${row.id})`),
      };
    }),
  );

profileFieldOptions(withFlags(profile.command('update')))
  .description('Update an agent profile (only provided flags change)')
  .argument('<slug>')
  .option('--name <name>')
  .option('--default', 'make this the global default')
  .option('--enabled', 'enable the profile')
  .option('--disabled', 'disable the profile')
  .action((slug: string, opts: LeafOpts) =>
    emit('profile update', opts, async () => {
      const update = coerceProfileFields(opts);
      const { mutations, queries } = await loadDb();
      const current = await resolveProfileSlug(queries, slug);
      await applyScheduleProject(update, opts, queries);
      const row = await mutations.updateProfile(current.id, update, current); // reuse the row we just loaded
      if (!row) throw new NotFoundError('profile', slug);
      const warnings = scanForLeakedSecrets(row);
      warnings.forEach((w) => process.stderr.write(`Warning: ${w}\n`));
      return {
        data: warnings.length ? { ...row, warnings } : row,
        human: () => console.log(`Updated ${row.slug}`),
      };
    }),
  );

withFlags(profile.command('set-default'))
  .description('Make a profile the single global default (idempotent)')
  .argument('<slug>')
  .action((slug: string, opts: LeafOpts) =>
    emit('profile set-default', opts, async () => {
      const { mutations, queries } = await loadDb();
      const current = await resolveProfileSlug(queries, slug);
      const row = await mutations.setDefaultProfile(current.id);
      if (!row) throw new NotFoundError('profile', slug);
      return { data: row, human: () => console.log(`Default → ${row.slug}`) };
    }),
  );

withFlags(profile.command('checked-in'))
  .description('Record a scheduled check-in (the scheduler calls this; advances the clock + failure tracking)')
  .argument('<slug>')
  .option('--status <s>', 'ok | fail (omit to only advance last_check_in_at, at spawn time)')
  .action((slug: string, opts: LeafOpts) =>
    emit('profile checked-in', opts, async () => {
      const status =
        opts.status === undefined ? undefined : assertEnum(String(opts.status), ['ok', 'fail'] as const, 'status');
      const { mutations } = await loadDb();
      const row = await mutations.recordProfileCheckIn(slug, status);
      if (!row) throw new NotFoundError('profile', slug, NO_PROFILE_HINT);
      return {
        data: row,
        human: () =>
          console.log(
            `Checked in ${row.slug}${status ? ` (${status})` : ''}${row.scheduleEnabled ? '' : ' — schedule auto-paused'}`,
          ),
      };
    }),
  );

withFlags(profile.command('rm'))
  .description('Delete an agent profile')
  .argument('<slug>')
  .option('--yes', 'confirm destructive delete')
  .action((slug: string, opts: LeafOpts) =>
    emit('profile rm', opts, async () => {
      if (!opts.yes) throw new ValidationError('yes', 'Refusing to delete without --yes');
      const { mutations, queries } = await loadDb();
      const current = await resolveProfileSlug(queries, slug);
      const row = await mutations.deleteProfile(current.id);
      if (!row) throw new NotFoundError('profile', slug);
      return { data: row, human: () => console.log(`Deleted ${slug}`) };
    }),
  );

withFlags(profile.command('resolve'))
  .description('Preview which profile auto-routing picks for a project/task')
  .option('--project <slug>', 'project context (provides slug + category)')
  .option('--task <id>', 'task context (provides kind + label)')
  .option('--label <text>', 'task label override')
  .option('--kind <kind>', 'task kind override (custom | integration)')
  .action((opts: LeafOpts) =>
    emit('profile resolve', opts, async () => {
      const { queries } = await loadDb();
      const ctx: MatchContext = {};
      if (opts.project) {
        const p = await resolveProject(queries, String(opts.project));
        ctx.projectSlug = p.slug;
        ctx.projectCategory = p.category;
      }
      if (opts.task) {
        const t = await queries.getTaskById(String(opts.task));
        if (!t) throw new NotFoundError('task', String(opts.task));
        ctx.taskKind = t.kind;
        ctx.taskLabel = t.label;
      }
      if (opts.kind !== undefined) ctx.taskKind = String(opts.kind);
      if (opts.label !== undefined) ctx.taskLabel = String(opts.label);
      const resolved = await queries.resolveProfile(ctx);
      return {
        data: { profile: resolved, context: ctx },
        human: () =>
          console.log(
            resolved
              ? `${resolved.slug} (${resolved.isDefault && !ctx.projectSlug ? 'default' : 'matched'})`
              : 'no matching profile and no default',
          ),
      };
    }),
  );

const run = program.command('run').description('Manage agent runs (sessions)');

withFlags(run.command('start'))
  .description('Open an agent run (prints the runId)')
  .requiredOption('--agent <label>', 'agent label (e.g. claude-code)')
  .option('--project <slug>', 'associate the run with a project')
  .option('--profile <slug>', 'link the run to an agent profile')
  .option('--title <title>')
  .option('--source <source>', RUN_SOURCES.join(' | '), 'cli')
  .option('--model <model>')
  .option('--session-id <id>', "Claude Code's session_id")
  .option('--work-dir <dir>')
  .option('--id <uuid>', 'client-supplied run id (idempotent upsert)')
  .action((opts: LeafOpts) =>
    emit('run start', opts, async () => {
      const source = assertEnum(String(opts.source ?? 'cli'), RUN_SOURCES, 'source');
      const label = String(opts.agent);
      const { mutations, queries } = await loadDb();
      const projectId = opts.project ? await resolveProjectId(queries, String(opts.project)) : null;
      const agentProfileId = opts.profile ? (await resolveProfileSlug(queries, String(opts.profile))).id : null;
      const row = await withActor({ label, kind: 'agent' }, () =>
        mutations.recordRunStart({
          id: opts.id ? String(opts.id) : undefined,
          agentLabel: label,
          projectId,
          agentProfileId,
          title: opts.title ? String(opts.title) : null,
          source,
          model: opts.model ? String(opts.model) : null,
          sessionId: opts.sessionId ? String(opts.sessionId) : null,
          workDir: opts.workDir ? String(opts.workDir) : null,
        }),
      );
      return { data: row, human: () => console.log(row.id) };
    }),
  );

withFlags(run.command('end'))
  .description('Close a run with a terminal status')
  .argument('<id>')
  .argument('<status>', RUN_STATUSES.filter((s) => s !== 'running').join(' | '))
  .option('--tokens-in <n>')
  .option('--tokens-out <n>')
  .option('--cache-read <n>')
  .option('--cache-write <n>')
  .option('--cost-micros <n>')
  .option('--authoritative', 'SET metrics exactly (override the GREATEST guard) — for a trusted final total')
  .option('--agent <label>')
  .action((id: string, status: string, opts: LeafOpts) =>
    emit('run end', opts, async () => {
      const s = assertEnum(status, RUN_STATUSES, 'status');
      const { mutations } = await loadDb();
      const row = await withActor({ label: actorLabel(opts), kind: 'agent', runId: id }, () =>
        mutations.recordRunEnd(id, s, metricsFrom(opts), Boolean(opts.authoritative)),
      );
      if (!row) throw new NotFoundError('run', id);
      return { data: row, human: () => console.log(`run ${id} → ${s}`) };
    }),
  );

withFlags(run.command('list'))
  .description('List recent runs (newest heartbeat first)')
  .option('--active', 'only running runs')
  .option('--agent <label>', 'filter by agent label')
  .option('--limit <n>', 'max rows returned', '50')
  .action((opts: LeafOpts) =>
    emit('run list', opts, async () => {
      const { queries } = await loadDb();
      let items = await queries.getRecentRuns({
        active: !!opts.active,
        limit: parseInt(String(opts.limit), 10) || 50,
      });
      if (opts.agent) items = items.filter((r) => r.agentLabel === String(opts.agent));
      return {
        data: { items, count: items.length },
        human: () => {
          items.forEach((r) =>
            console.log(
              `${r.live ? '●' : '○'} ${r.status.padEnd(10)} ${r.agentLabel.padEnd(16)} ${r.title ?? ''}`,
            ),
          );
          console.log(`\n${items.length} runs`);
        },
      };
    }),
  );

withFlags(run.command('get'))
  .description('Show a run with its event trail')
  .argument('<id>')
  .action((id: string, opts: LeafOpts) =>
    emit('run get', opts, async () => {
      const { queries } = await loadDb();
      const row = await queries.getRunById(id);
      if (!row) throw new NotFoundError('run', id);
      return {
        data: row,
        human: () => {
          console.log(
            `${row.live ? '●' : '○'} ${row.status}  ${row.agentLabel}${row.title ? `  ${row.title}` : ''}${row.cancelRequested ? '  ⚠ cancel requested' : ''}`,
          );
          console.log(
            `tokens ${row.tokensIn}/${row.tokensOut}  cache ${row.cacheReadTokens}/${row.cacheWriteTokens}  cost ${usdMicros(row.costMicros)}`,
          );
          console.log(`source ${row.source}${row.model ? `  model ${row.model}` : ''}`);
          if (row.project) console.log(`project ${row.project.name}`);
          if (row.claimedTask) console.log(`claimed ▸ ${row.claimedTask.label}`);
          console.log(
            `started ${row.startedAt.toISOString()}  last hb ${row.lastHeartbeatAt.toISOString()}${row.endedAt ? `  ended ${row.endedAt.toISOString()}` : ''}`,
          );
          console.log(`\n${row.events.length}${row.eventsTruncated ? ' (latest, truncated)' : ''} events:`);
          row.events.forEach((e) =>
            console.log(`  ${e.createdAt.toISOString()} [${e.level}] ${e.type.padEnd(18)} ${e.summary}`),
          );
        },
      };
    }),
  );

withFlags(run.command('cancel'))
  .description('Request cancellation of a running run (sets cancel_requested; enforced by the PreToolUse kill-switch hook when installed)')
  .argument('<id>')
  .action((id: string, opts: LeafOpts) =>
    emit('run cancel', opts, async () => {
      const { mutations } = await loadDb();
      const row = await mutations.setRunCancelRequested(id);
      if (!row) throw new NotFoundError('run', id); // ConflictError (terminal run) propagates from the mutation
      return {
        data: row,
        human: () => console.log(`Cancel requested for run ${id.slice(0, 8)} (${row.agentLabel}) — the kill-switch hook halts its next tool call when wired`),
      };
    }),
  );

// ── spend ──
withFlags(program.command('spend'))
  .description('Cost rollup over runs (grouped, optionally windowed)')
  .option('--group-by <dim>', SPEND_GROUP_BYS.join(' | '), 'project')
  .option('--since <date>', 'only runs started on/after this ISO date')
  .option('--until <date>', 'only runs started before this ISO date')
  .option('--project <slug>', 'scope to one project')
  .option('--agent <label>', 'scope to one agent label')
  .option('--profile <slug>', 'scope to one agent profile')
  .option('--limit <n>', 'max buckets returned', '50')
  .action((opts: LeafOpts) =>
    emit('spend', opts, async () => {
      const groupBy = assertEnum(String(opts.groupBy ?? 'project'), SPEND_GROUP_BYS, 'group-by');
      const since = opts.since ? parseDate(opts.since, 'since') : undefined;
      const until = opts.until ? parseDate(opts.until, 'until') : undefined;
      let limit = 50;
      if (opts.limit !== undefined) {
        const n = num(opts.limit);
        if (n === undefined || n < 1) throw new ValidationError('limit', `Invalid limit "${opts.limit}" — must be a positive integer`);
        limit = n;
      }
      const { queries } = await loadDb();
      const projectId = opts.project ? await resolveProjectId(queries, String(opts.project)) : undefined;
      const profileId = opts.profile ? (await resolveProfileSlug(queries, String(opts.profile))).id : undefined;
      const rollup = await queries.getSpendRollup({
        groupBy,
        since,
        until,
        projectId,
        agentLabel: opts.agent ? String(opts.agent) : undefined,
        profileId,
        limit,
      });
      return {
        // The rollup is its own shape (rows + totals + truncated), not the {items,count} list envelope —
        // a bolted-on count would be ambiguous next to `truncated`, so callers read rows/totals/truncated.
        data: rollup,
        human: () => {
          rollup.rows.forEach((r) =>
            console.log(`${usdMicros(r.costMicros).padStart(13)}  ${String(r.runCount).padStart(4)} run${r.runCount === 1 ? ' ' : 's'}  ${r.label}`),
          );
          console.log(
            `\n${usdMicros(rollup.totals.costMicros)} total · ${rollup.totals.runCount} runs · ${rollup.rows.length} ${rollup.groupBy} bucket${rollup.rows.length === 1 ? '' : 's'}${rollup.truncated ? ' (truncated)' : ''}`,
          );
        },
      };
    }),
  );

// ── event ──
const event = program.command('event').description('Activity-log events');

withFlags(event.command('add'))
  .description('Append an event to the activity log')
  .argument('<summary...>')
  .requiredOption('--type <type>', EVENT_TYPES.join(' | '))
  .option('--level <level>', EVENT_LEVELS.join(' | '), 'info')
  .option('--project <slug>')
  .option('--task <id>')
  .option('--run <id>')
  .option('--agent <label>')
  .action((summaryParts: string[], opts: LeafOpts) =>
    emit('event add', opts, async () => {
      const type = assertEnum(String(opts.type), EVENT_TYPES, 'type');
      const level = assertEnum(String(opts.level ?? 'info'), EVENT_LEVELS, 'level');
      const summary = summaryParts.join(' ').trim();
      if (!summary) throw new ValidationError('summary', 'Event summary cannot be empty');
      const { mutations, queries } = await loadDb();
      const projectId = opts.project ? await resolveProjectId(queries, String(opts.project)) : null;
      const runId = opts.run ? String(opts.run) : null;
      const row = await withActor({ label: actorLabel(opts), kind: 'agent', runId }, () =>
        mutations.createEvent({
          type,
          summary,
          level,
          projectId,
          taskId: opts.task ? String(opts.task) : null,
          runId,
        }),
      );
      return { data: row, human: () => console.log(`event ${row.id} [${type}] ${summary}`) };
    }),
  );

withFlags(event.command('list'))
  .description('List recent events (newest first)')
  .option('--project <slug>')
  .option('--run <id>')
  .option('--level <level>', `minimum level (${EVENT_LEVELS.join('|')})`)
  .option('--limit <n>', 'max rows returned', '50')
  .action((opts: LeafOpts) =>
    emit('event list', opts, async () => {
      const { queries } = await loadDb();
      const projectId = opts.project ? await resolveProjectId(queries, String(opts.project)) : undefined;
      const minLevel = opts.level ? assertEnum(String(opts.level), EVENT_LEVELS, 'level') : undefined;
      const items = await queries.getEvents({
        projectId,
        runId: opts.run ? String(opts.run) : undefined,
        minLevel,
        limit: parseInt(String(opts.limit), 10) || 50,
      });
      return {
        data: { items, count: items.length },
        human: () => {
          items.forEach((e) =>
            console.log(
              `${e.createdAt.toISOString()} [${e.level}] ${e.type.padEnd(20)} ${e.actorLabel.padEnd(14)} ${e.summary}`,
            ),
          );
          console.log(`\n${items.length} events`);
        },
      };
    }),
  );

/** Resolve the current run: MC_RUN_ID env → else the cwd-keyed file the SessionStart hook wrote. */
function resolveRunId(): string | null {
  if (process.env.MC_RUN_ID) return process.env.MC_RUN_ID;
  try {
    const key = createHash('sha1').update(process.cwd()).digest('hex').slice(0, 16);
    const id = readFileSync(join(tmpdir(), `mc-run-${key}`), 'utf8').trim();
    return id || null;
  } catch {
    return null;
  }
}

// True only when this file is the process entrypoint (`mc …` / `tsx cli/index.ts …`), not when it's
// imported (the spec-sync test loads the module for its SPEC/ENUMS/program catalog). realpathSync on
// both sides collapses the `bin/../cli` path the launcher passes + any symlinks before comparing.
function isEntrypoint(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Bind a base actor for the whole invocation from the environment, so EVERY mutating command
// (task set-status, integration set, …) attributes its audit-log entry to the agent + run.
// The run/event commands nest a more specific actor (e.g. `run start --agent`) which overrides this.
if (isEntrypoint()) {
  withActor(
    { label: process.env.MC_AGENT ?? 'mc', kind: 'agent', runId: resolveRunId() },
    () => program.parseAsync(process.argv),
  ).catch((err) => {
    const info = classify(err);
    process.stderr.write(`Error [${info.code}] ${info.message}\n`);
    process.exitCode = info.exit;
  });
}

// Exported for the spec-sync test (test/spec-sync.test.ts) — the live command tree + static catalogs.
export { program, SPEC, ENUMS };

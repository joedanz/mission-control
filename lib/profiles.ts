// ABOUTME: Pure, framework-agnostic agent-profile logic — input types, cross-field validation, the
// ABOUTME: auto-routing match predicate, and a soft secret-leak scan. No DB / Next imports, so the CLI,
// ABOUTME: web actions, the daemon (Slice 2), and tests all share one source of truth. The DB read/write
// ABOUTME: lives in lib/queries + lib/mutations; resolution ORDER lives in lib/queries.resolveProfile.

import {
  PROFILE_RUNTIMES,
  PERMISSION_MODES,
  type ProfileRuntime,
  type PermissionMode,
  type McpServerConfig,
  type ProfileMatchRules,
  type Category,
} from './db/schema';
import { assertEnum, ValidationError } from './validation';
import { Cron } from 'croner';
import { SCHEDULE_MIN_INTERVAL_SEC } from './constants';

const MCP_TRANSPORTS = ['stdio', 'http', 'sse', 'ws'] as const;

/** Friendly create payload. `slug`/`name` required; everything else optional (the table fills defaults). */
export type ProfileInput = {
  slug: string;
  name: string;
  description?: string | null;
  runtime?: ProfileRuntime;
  model?: string | null;
  fallbackModel?: string | null;
  dailyBudgetMicros?: number | null;
  provider?: string | null;
  baseUrl?: string | null;
  permissionMode?: PermissionMode | null;
  skills?: string[];
  mcpServers?: Record<string, McpServerConfig> | null;
  allowedTools?: string[];
  disallowedTools?: string[];
  appendSystemPrompt?: string | null;
  env?: Record<string, string>;
  execTemplate?: string | null;
  matchRules?: ProfileMatchRules | null;
  priority?: number;
  isDefault?: boolean;
  enabled?: boolean;
  // Scheduled check-ins (Slice 5). scheduleProjectId is the RESOLVED project id (the CLI maps --schedule-project
  // slug → id). Cron, when set, overrides interval. See validateProfile for the cross-field invariants.
  scheduleEnabled?: boolean;
  scheduleProjectId?: string | null;
  scheduleIntervalSec?: number | null;
  scheduleCron?: string | null;
  scheduleTimezone?: string | null;
  checkInPrompt?: string | null;
};

/** Partial — only the keys present are written (serves the CLI's partial `profile update`). */
export type ProfileUpdate = Partial<ProfileInput>;

/** The cross-field invariants validated for an EFFECTIVE profile (create input, or update merged onto the
 *  current row). Throws ValidationError (CLI exit 2) listing valid values so an agent can self-correct. */
export type EffectiveProfile = {
  runtime: string;
  permissionMode?: string | null;
  execTemplate?: string | null;
  mcpServers?: Record<string, McpServerConfig> | null;
  matchRules?: ProfileMatchRules | null;
  dailyBudgetMicros?: number | null;
  scheduleEnabled?: boolean;
  scheduleProjectId?: string | null;
  scheduleIntervalSec?: number | null;
  scheduleCron?: string | null;
  scheduleTimezone?: string | null;
};

/** True if `expr` is a cron expression croner can parse. Shared by validation and the scheduler so a
 *  bad expression is rejected at write time, not at fire time. */
export function isValidCron(expr: string): boolean {
  try {
    new Cron(expr);
    return true;
  } catch {
    return false;
  }
}

/** True if `tz` is a valid IANA timezone. Uses Intl (croner's own backend), so a zone accepted here is one
 *  croner can evaluate — rejected at write time rather than throwing inside the scheduler tick. croner does
 *  NOT validate the zone at `new Cron(...)`; it throws only later in nextRun, hence this explicit gate. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validate runtime/permissionMode enums, the exec-template-required-for-exec rule, the mcpServers shape,
 *  and that matchRules.labelPattern compiles as a regex. Pure — no DB. */
export function validateProfile(p: EffectiveProfile): void {
  const runtime = assertEnum(p.runtime, PROFILE_RUNTIMES, 'runtime');
  if (p.permissionMode != null && p.permissionMode !== '') {
    assertEnum(p.permissionMode, PERMISSION_MODES, 'permissionMode');
  }
  // runtime='exec' drives a non-Claude runner, so the command template is mandatory — without it the
  // daemon has nothing to spawn. runtime='claude-code' ignores execTemplate (it uses `claude -p` flags).
  if (runtime === 'exec' && !(p.execTemplate && p.execTemplate.trim())) {
    throw new ValidationError('execTemplate', "runtime 'exec' requires --exec-template (the command to run)");
  }
  if (p.dailyBudgetMicros != null && (!Number.isFinite(p.dailyBudgetMicros) || p.dailyBudgetMicros < 0)) {
    throw new ValidationError('dailyBudgetMicros', 'dailyBudgetMicros must be a non-negative integer (micro-dollars)');
  }
  if (p.mcpServers != null) validateMcpServers(p.mcpServers);
  if (p.matchRules?.labelPattern != null && p.matchRules.labelPattern !== '') {
    try {
      new RegExp(p.matchRules.labelPattern);
    } catch {
      throw new ValidationError('matchRules.labelPattern', `Invalid regex: ${p.matchRules.labelPattern}`);
    }
  }
  validateSchedule(p);
}

/** Scheduled check-in invariants. Format checks always apply (a bad interval/cron is rejected even on a
 *  disabled schedule); the requires-a-trigger rules apply only when the schedule is enabled, so a profile
 *  can carry a half-configured schedule and be turned on later in one `--schedule-enabled` call. */
function validateSchedule(p: EffectiveProfile): void {
  const hasInterval = p.scheduleIntervalSec != null;
  const hasCron = p.scheduleCron != null && p.scheduleCron !== '';
  const hasTz = p.scheduleTimezone != null && p.scheduleTimezone !== '';
  if (hasInterval && (!Number.isInteger(p.scheduleIntervalSec) || (p.scheduleIntervalSec as number) < SCHEDULE_MIN_INTERVAL_SEC)) {
    throw new ValidationError(
      'scheduleIntervalSec',
      `scheduleIntervalSec must be an integer ≥ ${SCHEDULE_MIN_INTERVAL_SEC} (seconds) — each check-in spawns a paid run`,
    );
  }
  if (hasCron && !isValidCron(p.scheduleCron as string)) {
    throw new ValidationError('scheduleCron', `Invalid cron expression: ${p.scheduleCron}`);
  }
  if (hasTz && !isValidTimezone(p.scheduleTimezone as string)) {
    throw new ValidationError('scheduleTimezone', `Invalid IANA timezone: ${p.scheduleTimezone}`);
  }
  if (!p.scheduleEnabled) return;
  if (p.scheduleProjectId == null || p.scheduleProjectId === '') {
    throw new ValidationError('scheduleProjectId', 'an enabled schedule needs --schedule-project <slug> (the project the check-in runs in)');
  }
  if (hasInterval === hasCron) {
    throw new ValidationError(
      'schedule',
      'an enabled schedule needs exactly one of --schedule-interval <sec> or --schedule-cron <expr>',
    );
  }
}

function validateMcpServers(servers: Record<string, McpServerConfig>): void {
  if (typeof servers !== 'object' || Array.isArray(servers)) {
    throw new ValidationError('mcpServers', 'mcpServers must be an object keyed by server name');
  }
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg == null || typeof cfg !== 'object') {
      throw new ValidationError('mcpServers', `server "${name}" must be an object`);
    }
    if (cfg.type != null && !(MCP_TRANSPORTS as readonly string[]).includes(cfg.type)) {
      throw new ValidationError('mcpServers', `server "${name}" type must be one of: ${MCP_TRANSPORTS.join(', ')}`, MCP_TRANSPORTS);
    }
    const transport = cfg.type ?? (cfg.command ? 'stdio' : 'http');
    if (transport === 'stdio' && !cfg.command) {
      throw new ValidationError('mcpServers', `stdio server "${name}" requires a command`);
    }
    if (transport !== 'stdio' && !cfg.url) {
      throw new ValidationError('mcpServers', `${transport} server "${name}" requires a url`);
    }
  }
}

// ── Auto-routing ─────────────────────────────────────────────────────────────────

/** What the resolver knows about the task being routed. Any dimension may be absent (e.g. resolving by
 *  project alone); a matchRule that needs an absent dimension simply doesn't match. */
export type MatchContext = {
  projectSlug?: string | null;
  projectCategory?: Category | null;
  taskLabel?: string | null;
};

/** Does this profile's matchRules apply to `ctx`? All present rules are ANDed; a profile with no rules
 *  (or an empty ruleset) never matches by rule — it can only be the isDefault fallback. Pure + total:
 *  a rule whose dimension is missing from ctx fails closed (so a label-rule profile won't fire on a
 *  project-only resolve). Disabled profiles are filtered by the caller, not here. */
export function profileMatchesContext(rules: ProfileMatchRules | null | undefined, ctx: MatchContext): boolean {
  if (!rules) return false;
  const { projectSlugs, projectCategories, labelPattern } = rules;
  // Each present rule must pass (fail closed if its dimension is absent); `matched` makes an empty
  // ruleset return false without restating the rule-key list a second time.
  let matched = false;
  if (projectSlugs?.length) {
    if (!ctx.projectSlug || !projectSlugs.includes(ctx.projectSlug)) return false;
    matched = true;
  }
  if (projectCategories?.length) {
    if (!ctx.projectCategory || !projectCategories.includes(ctx.projectCategory)) return false;
    matched = true;
  }
  if (labelPattern && labelPattern !== '') {
    if (!ctx.taskLabel) return false;
    try {
      if (!new RegExp(labelPattern).test(ctx.taskLabel)) return false;
    } catch {
      return false; // an un-compilable pattern (shouldn't reach here post-validation) fails closed
    }
    matched = true;
  }
  return matched;
}

// ── Secret-leak guard (soft) ───────────────────────────────────────────────────-

const SECRET_SHAPE = /(sk-[A-Za-z0-9]{12,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]+)/;

/** Returns human-readable warnings for env / mcp header+env values that look like RAW secrets instead of
 *  `${ENV}` placeholders. Soft by design — MC's contract is placeholders-only, but we warn (not block) so
 *  a legitimate non-secret literal isn't rejected. The CLI surfaces these on stderr / in the envelope. */
export function scanForLeakedSecrets(p: {
  env?: Record<string, string> | null;
  mcpServers?: Record<string, McpServerConfig> | null;
}): string[] {
  const warnings: string[] = [];
  const check = (where: string, value: unknown) => {
    if (typeof value !== 'string') return;
    if (value.includes('${')) return; // a placeholder — fine
    if (SECRET_SHAPE.test(value)) warnings.push(`${where} looks like a raw secret — use a \${ENV_VAR} placeholder instead`);
  };
  for (const [k, v] of Object.entries(p.env ?? {})) check(`env.${k}`, v);
  for (const [name, cfg] of Object.entries(p.mcpServers ?? {})) {
    for (const [k, v] of Object.entries(cfg?.env ?? {})) check(`mcpServers.${name}.env.${k}`, v);
    for (const [k, v] of Object.entries(cfg?.headers ?? {})) check(`mcpServers.${name}.headers.${k}`, v);
  }
  return warnings;
}

// ABOUTME: Pure UI-state ⇄ ProfileInput transform for the rich Profiles editor. Isolated from React so the
// ABOUTME: gnarly normalization (chips→string[], key/value rows→Record, MCP-server cards→canonical inner map,
// ABOUTME: match-rule pickers→ProfileMatchRules, ''→null) is unit-testable without a DOM. The editor holds
// ABOUTME: everything as strings/arrays the form fields produce; this maps that to/from what the mutation wants.

import type {
  AgentProfile,
  McpServerConfig,
  ProfileMatchRules,
  PermissionMode,
  ProfileRuntime,
  Category,
} from './db/schema';
import type { ProfileInput } from './profiles';

export type KvRow = { key: string; value: string };

export type McpRow = {
  name: string;
  type: 'stdio' | 'http' | 'sse' | 'ws';
  command: string; // stdio
  args: string; // stdio — comma-separated in the UI
  url: string; // http/sse/ws
  env: KvRow[];
  headers: KvRow[];
};

/** Everything the editor holds, as the form fields produce it (strings, arrays, rows). */
export type ProfileFormState = {
  slug: string;
  name: string;
  description: string;
  runtime: ProfileRuntime;
  model: string;
  fallbackModel: string;
  dailyBudgetUsd: string; // human dollars in the editor; stored as micro-dollars
  provider: string;
  baseUrl: string;
  permissionMode: string; // '' = none
  skills: string[];
  allowedTools: string[];
  disallowedTools: string[];
  appendSystemPrompt: string;
  env: KvRow[];
  execTemplate: string;
  mcpServers: McpRow[];
  matchProjectSlugs: string[];
  matchProjectCategories: Category[];
  matchLabelPattern: string;
  priority: string; // numeric text
  isDefault: boolean;
  enabled: boolean;
  // Scheduled check-in. scheduleProjectId is the project ID (the picker stores the id directly).
  // scheduleMode is UI-only: interval and cron are mutually exclusive, so the editor holds one trigger
  // active at a time and formStateToInput emits exactly that one (the other → null).
  scheduleEnabled: boolean;
  scheduleProjectId: string; // '' = none
  scheduleMode: 'interval' | 'cron';
  scheduleIntervalSec: string; // numeric text
  scheduleCron: string;
  scheduleTimezone: string; // IANA zone for cron mode; '' = the daemon/web process's local time
  checkInPrompt: string;
};

export function emptyFormState(): ProfileFormState {
  return {
    slug: '',
    name: '',
    description: '',
    runtime: 'claude-code',
    model: '',
    fallbackModel: '',
    dailyBudgetUsd: '',
    provider: '',
    baseUrl: '',
    permissionMode: '',
    skills: [],
    allowedTools: [],
    disallowedTools: [],
    appendSystemPrompt: '',
    env: [],
    execTemplate: '',
    mcpServers: [],
    matchProjectSlugs: [],
    matchProjectCategories: [],
    matchLabelPattern: '',
    priority: '0',
    isDefault: false,
    enabled: true,
    scheduleEnabled: false,
    scheduleProjectId: '',
    scheduleMode: 'interval',
    scheduleIntervalSec: '',
    scheduleCron: '',
    scheduleTimezone: '',
    checkInPrompt: '',
  };
}

const orNull = (s: string): string | null => {
  const t = s.trim();
  return t === '' ? null : t;
};

const chips = (xs: string[]): string[] => xs.map((x) => x.trim()).filter(Boolean);

const rowsToRecord = (rows: KvRow[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) {
    const k = key.trim();
    if (k) out[k] = value;
  }
  return out;
};

/** A KvRow[] → Record, or undefined when empty (so the server stores a tidy object, not `{}`). */
const rowsToRecordOpt = (rows: KvRow[]): Record<string, string> | undefined => {
  const rec = rowsToRecord(rows);
  return Object.keys(rec).length ? rec : undefined;
};

function cardToConfig(card: McpRow): McpServerConfig {
  const cfg: McpServerConfig = { type: card.type };
  if (card.type === 'stdio') {
    const command = card.command.trim();
    if (command) cfg.command = command;
    const args = chips(card.args.split(','));
    if (args.length) cfg.args = args;
  } else {
    const url = card.url.trim();
    if (url) cfg.url = url;
  }
  const env = rowsToRecordOpt(card.env);
  if (env) cfg.env = env;
  const headers = rowsToRecordOpt(card.headers);
  if (headers) cfg.headers = headers;
  return cfg;
}

/** Build the match-rules object from the picker fields, or null when no dimension is set. */
function buildMatchRules(s: ProfileFormState): ProfileMatchRules | null {
  const rules: ProfileMatchRules = {};
  if (s.matchProjectSlugs.length) rules.projectSlugs = s.matchProjectSlugs;
  if (s.matchProjectCategories.length) rules.projectCategories = s.matchProjectCategories;
  const label = s.matchLabelPattern.trim();
  if (label) rules.labelPattern = label;
  return Object.keys(rules).length ? rules : null;
}

/** Normalize the editor state into a complete ProfileInput. Produces explicit null/[]/object-or-null for
 *  every field so an EDIT replaces the whole profile (an emptied field clears). The server re-validates. */
export function formStateToInput(s: ProfileFormState): ProfileInput {
  const mcp: Record<string, McpServerConfig> = {};
  for (const card of s.mcpServers) {
    const name = card.name.trim();
    if (name) mcp[name] = cardToConfig(card);
  }
  const priority = Number.parseInt(s.priority, 10);
  const usd = s.dailyBudgetUsd.trim();
  const usdNum = Number(usd);
  const dailyBudgetMicros = usd === '' || !Number.isFinite(usdNum) || usdNum < 0 ? null : Math.round(usdNum * 1_000_000);
  // interval/cron are mutually exclusive — emit the active mode's trigger, null the other (the server's
  // exactly-one-of invariant rejects both/neither, so a half-filled form fails validation with a clear message).
  const intervalNum = Number.parseInt(s.scheduleIntervalSec.trim(), 10);
  const scheduleIntervalSec = s.scheduleMode === 'interval' && Number.isFinite(intervalNum) ? intervalNum : null;
  const scheduleCron = s.scheduleMode === 'cron' ? orNull(s.scheduleCron) : null;
  return {
    slug: s.slug.trim(),
    name: s.name.trim(),
    description: orNull(s.description),
    runtime: s.runtime,
    model: orNull(s.model),
    fallbackModel: orNull(s.fallbackModel),
    dailyBudgetMicros,
    provider: orNull(s.provider),
    baseUrl: orNull(s.baseUrl),
    permissionMode: (orNull(s.permissionMode) as PermissionMode | null) ?? null,
    skills: chips(s.skills),
    allowedTools: chips(s.allowedTools),
    disallowedTools: chips(s.disallowedTools),
    appendSystemPrompt: orNull(s.appendSystemPrompt),
    env: rowsToRecord(s.env),
    execTemplate: orNull(s.execTemplate),
    mcpServers: Object.keys(mcp).length ? mcp : null,
    matchRules: buildMatchRules(s),
    priority: Number.isNaN(priority) ? 0 : priority,
    isDefault: s.isDefault,
    enabled: s.enabled,
    scheduleEnabled: s.scheduleEnabled,
    scheduleProjectId: orNull(s.scheduleProjectId),
    scheduleIntervalSec,
    scheduleCron,
    scheduleTimezone: orNull(s.scheduleTimezone),
    checkInPrompt: orNull(s.checkInPrompt),
  };
}

const recordToRows = (rec: Record<string, string> | null | undefined): KvRow[] =>
  Object.entries(rec ?? {}).map(([key, value]) => ({ key, value }));

function configToCard(name: string, cfg: McpServerConfig): McpRow {
  return {
    name,
    type: cfg.type ?? (cfg.command ? 'stdio' : 'http'),
    command: cfg.command ?? '',
    args: (cfg.args ?? []).join(', '),
    url: cfg.url ?? '',
    env: recordToRows(cfg.env),
    headers: recordToRows(cfg.headers),
  };
}

/** Hydrate the editor state from a stored profile (the EDIT path). */
export function formStateFromProfile(p: AgentProfile): ProfileFormState {
  const m = p.matchRules ?? {};
  return {
    slug: p.slug,
    name: p.name,
    description: p.description ?? '',
    runtime: p.runtime as ProfileRuntime,
    model: p.model ?? '',
    fallbackModel: p.fallbackModel ?? '',
    dailyBudgetUsd: p.dailyBudgetMicros == null ? '' : String(p.dailyBudgetMicros / 1_000_000),
    provider: p.provider ?? '',
    baseUrl: p.baseUrl ?? '',
    permissionMode: p.permissionMode ?? '',
    skills: p.skills,
    allowedTools: p.allowedTools,
    disallowedTools: p.disallowedTools,
    appendSystemPrompt: p.appendSystemPrompt ?? '',
    env: recordToRows(p.env),
    execTemplate: p.execTemplate ?? '',
    mcpServers: Object.entries(p.mcpServers ?? {}).map(([name, cfg]) => configToCard(name, cfg)),
    matchProjectSlugs: m.projectSlugs ?? [],
    matchProjectCategories: m.projectCategories ?? [],
    matchLabelPattern: m.labelPattern ?? '',
    priority: String(p.priority),
    isDefault: p.isDefault,
    enabled: p.enabled,
    scheduleEnabled: p.scheduleEnabled,
    scheduleProjectId: p.scheduleProjectId ?? '',
    // A stored cron expression means the profile is in cron mode; otherwise interval (the default).
    scheduleMode: p.scheduleCron ? 'cron' : 'interval',
    scheduleIntervalSec: p.scheduleIntervalSec == null ? '' : String(p.scheduleIntervalSec),
    scheduleCron: p.scheduleCron ?? '',
    scheduleTimezone: p.scheduleTimezone ?? '',
    checkInPrompt: p.checkInPrompt ?? '',
  };
}

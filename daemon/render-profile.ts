// ABOUTME: Pure profile→spawn rendering for the auto-claim daemon (Slice 2). Turns a resolved
// ABOUTME: AgentProfile into a concrete spawn plan — rich `claude -p` flags (runtime=claude-code) or an
// ABOUTME: execTemplate command (runtime=exec, the non-Claude path) — and resolves ${ENV} placeholders for
// ABOUTME: env + MCP config from the host environment at spawn. No fs / no spawn / no DB, so it's unit-
// ABOUTME: testable in isolation; the daemon owns the side effects (temp-file write, fork, cleanup).

import type { AgentProfile, McpServerConfig } from '../lib/db/schema';

/** A profile carries `${VAR}` placeholders for secrets (MC never stores the secret itself). They are
 *  resolved from the daemon's own environment at spawn; an unset one is fatal — we fail the run with a
 *  clear message rather than spawn an agent with a broken/empty credential. */
export class MissingEnvError extends Error {
  readonly varName: string;
  constructor(varName: string, context: string) {
    super(`${context} references \${${varName}} but it is not set in the daemon environment`);
    this.name = 'MissingEnvError';
    this.varName = varName;
  }
}

type HostEnv = Record<string, string | undefined>;

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Replace every `${VAR}` in `value` with `hostEnv[VAR]`; throw MissingEnvError on the first unset one. */
export function resolvePlaceholders(value: string, hostEnv: HostEnv, context = 'value'): string {
  return value.replace(PLACEHOLDER, (_m, name: string) => {
    const v = hostEnv[name];
    if (v === undefined) throw new MissingEnvError(name, context);
    return v;
  });
}

/** Resolve every value in a profile's `env` map → the extra env the daemon merges into the child. */
export function resolveProfileEnv(env: Record<string, string> | null | undefined, hostEnv: HostEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) out[k] = resolvePlaceholders(v, hostEnv, `env.${k}`);
  return out;
}

/** Deep-resolve `${ENV}` in each server's `env`/`headers` (where secrets live) and return the canonical
 *  `--mcp-config` JSON (`{ "mcpServers": { ... } }`), or null when there are no servers. The daemon writes
 *  this to a 0600 temp file so resolved secrets never land in argv (visible via `ps`). */
export function resolveMcpConfigJson(
  servers: Record<string, McpServerConfig> | null | undefined,
  hostEnv: HostEnv,
): string | null {
  if (!servers || Object.keys(servers).length === 0) return null;
  const resolved: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    const next: McpServerConfig = { ...cfg };
    if (cfg.env) {
      next.env = Object.fromEntries(
        Object.entries(cfg.env).map(([k, v]) => [k, resolvePlaceholders(v, hostEnv, `mcpServers.${name}.env.${k}`)]),
      );
    }
    if (cfg.headers) {
      next.headers = Object.fromEntries(
        Object.entries(cfg.headers).map(([k, v]) => [k, resolvePlaceholders(v, hostEnv, `mcpServers.${name}.headers.${k}`)]),
      );
    }
    resolved[name] = next;
  }
  return JSON.stringify({ mcpServers: resolved });
}

/** Merge auto-fed MCP servers UNDER a profile's own. Spreading `extra` first then `base` makes the
 *  profile (base) win on a key collision. Returns null only when the merge is empty, so the caller can
 *  treat null as "no --mcp-config" exactly like a profile with no servers. */
export function mergeMcpServers(
  base: Record<string, McpServerConfig> | null | undefined,
  extra: Record<string, McpServerConfig> | null | undefined,
): Record<string, McpServerConfig> | null {
  const merged = { ...(extra ?? {}), ...(base ?? {}) };
  return Object.keys(merged).length ? merged : null;
}

// ── Spawn plan ────────────────────────────────────────────────────────────────────

export type SpawnPlan = {
  runtime: 'claude-code' | 'exec';
  bin: string; // 'claude' or 'sh'
  args: string[]; // full argv (exec: ['-c', command])
  extraEnv: Record<string, string>; // resolved profile.env to merge into the child
};

export type PlanOpts = {
  prompt: string;
  basePermissionMode: string; // the daemon's --permission-mode default (used when the profile omits one)
  mcpConfigPath?: string | null; // path of the temp file the daemon already wrote, or null
  hostEnv: HostEnv;
  // The model the daemon already chose for this run (via chooseModel — possibly the budget downgrade). When
  // omitted, planSpawn falls back to profile.model (dry-render / tests). Distinct from profile.fallbackModel,
  // which is ALWAYS rendered as claude's --fallback-model for overload resilience.
  effectiveModel?: string | null;
  // Tools the daemon grants ON TOP of the profile's own allowedTools, deduped + appended. The scheduler uses
  // this to grant `Bash(mc:*)` so a check-in can self-serve (claim/work tasks) via the mc CLI without the
  // operator having to remember to allow-list it. Applies only to the claude-code runtime.
  extraAllowedTools?: string[];
};

export type ModelChoice = { model: string | null; downgraded: boolean };

/** Cost-aware model pick (pure). If the profile has a daily budget AND a fallback model AND today's spend has
 *  reached the cap, route to the cheaper fallback; otherwise keep the primary model. A cap without a fallback
 *  has nothing to switch to, so it never downgrades. The daemon computes this ONCE (so the run record and the
 *  spawn agree) and passes the result back in via PlanOpts.effectiveModel. */
export function chooseModel(profile: AgentProfile | null, spentTodayMicros: number): ModelChoice {
  if (!profile) return { model: null, downgraded: false };
  const cap = profile.dailyBudgetMicros;
  if (cap != null && spentTodayMicros >= cap && profile.fallbackModel) {
    return { model: profile.fallbackModel, downgraded: true };
  }
  return { model: profile.model, downgraded: false };
}

/** POSIX single-quote escaping — wrap a value so the shell treats it as one inert literal (an injected
 *  `$(...)` / `;` in untrusted task text can't break out). `'` → `'\''` (close, escaped quote, reopen). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** There is no `claude -p --skills` flag — skills resolve via `/name` + auto-discovery. So a profile's
 *  `skills` list is STEERING: we tell the agent to prefer them, appended to the persona system prompt. */
function buildAppendPrompt(profile: AgentProfile): string | null {
  const parts: string[] = [];
  if (profile.appendSystemPrompt?.trim()) parts.push(profile.appendSystemPrompt.trim());
  if (profile.skills.length) parts.push(`Prefer these skills when relevant: ${profile.skills.map((s) => `/${s}`).join(' ')}`);
  return parts.length ? parts.join('\n\n') : null;
}

/** Render a resolved profile into the concrete spawn the daemon executes. A null profile (no match, no
 *  default) reproduces the daemon's historical `claude -p plan` invocation byte-for-byte (back-compat). */
export function planSpawn(profile: AgentProfile | null, opts: PlanOpts): SpawnPlan {
  const { prompt, basePermissionMode, mcpConfigPath, hostEnv } = opts;
  // The model the daemon chose (budget-aware), else the profile's primary. `undefined` = caller didn't decide.
  const model = profile ? (opts.effectiveModel !== undefined ? opts.effectiveModel : profile.model) : null;
  // Which `claude` to launch. Bare 'claude' is resolved off PATH — but a daemon started via `npm run` gets the
  // node_modules/.bin walk prepended, which can shadow the real install with a stale/broken one. MC_CLAUDE_BIN
  // lets the deployment pin an absolute path (mirrors MC_BIN for the mc CLI). See INSTALL.md.
  const claudeBin = hostEnv.MC_CLAUDE_BIN || 'claude';

  if (!profile) {
    // Historical back-compat invocation when nothing is auto-fed. With auto-fed Composio servers
    // (mcpConfigPath set), add --mcp-config + --strict-mcp-config exactly like the profile path —
    // the profileless agent then sees those servers and nothing else (no host MCP bleed-in).
    const args = ['-p', prompt, '--permission-mode', basePermissionMode, '--output-format', 'json'];
    if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
    return { runtime: 'claude-code', bin: claudeBin, args, extraEnv: {} };
  }

  const extraEnv = resolveProfileEnv(profile.env, hostEnv);

  if (profile.runtime === 'exec') {
    if (!profile.execTemplate?.trim()) {
      throw new Error(`profile "${profile.slug}" has runtime=exec but no execTemplate`);
    }
    // Substitute the three template tokens (shell-quoted); any remaining $VAR is left for `sh -c` to expand
    // from the merged child env (extraEnv), which is the natural exec contract.
    const command = profile.execTemplate
      .replace(/\$\{PROMPT\}/g, shellQuote(prompt))
      .replace(/\$\{MODEL\}/g, shellQuote(model ?? ''))
      .replace(/\$\{FALLBACK_MODEL\}/g, shellQuote(profile.fallbackModel ?? ''))
      .replace(/\$\{MCP_CONFIG\}/g, shellQuote(mcpConfigPath ?? ''));
    return { runtime: 'exec', bin: 'sh', args: ['-c', command], extraEnv };
  }

  // runtime = claude-code: map fields onto real `claude -p` flags (see `claude --help`).
  const args = ['-p', prompt, '--output-format', 'json'];
  args.push('--permission-mode', profile.permissionMode ?? basePermissionMode);
  if (model) args.push('--model', model);
  // --fallback-model is overload/unavailable resilience — always pass the profile's fallback when set,
  // independent of the budget downgrade (which already routed `model` above).
  if (profile.fallbackModel) args.push('--fallback-model', profile.fallbackModel);
  const append = buildAppendPrompt(profile);
  if (append) args.push('--append-system-prompt', append);
  // Profile tools + any daemon-granted extras (e.g. the scheduler's Bash(mc:*) for self-serve), deduped.
  const allowedTools = [...new Set([...profile.allowedTools, ...(opts.extraAllowedTools ?? [])])];
  if (allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
  if (profile.disallowedTools.length) args.push('--disallowed-tools', profile.disallowedTools.join(','));
  // --strict-mcp-config makes the profile's server set authoritative (no host MCP bleed-in → reproducible).
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
  return { runtime: 'claude-code', bin: claudeBin, args, extraEnv };
}

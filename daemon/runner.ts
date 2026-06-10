// ABOUTME: Shared daemon runner — the spawn/monitor/finalize/mc-shell primitives used by BOTH the
// ABOUTME: auto-claim daemon (per-project task puller) and the scheduler daemon (per-profile scheduled
// ABOUTME: check-ins). Extracted so the two daemons share one battle-tested spawn path; each owns only its
// ABOUTME: own loop. No top-level side effects (no main()), so it's safe to import from either entrypoint.

import { spawn, type SpawnOptions } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AgentProfile, McpServerConfig } from '../lib/db/schema';
import { planSpawn, resolveMcpConfigJson, mergeMcpServers, MissingSkillError, type ModelChoice } from './render-profile';
import { resolveSkills, userSkillsDir } from '../lib/skills';
import { loadPluginContext, pluginSkillStatus } from '../lib/plugin-skills';
// Pure transcript parser shared with the Claude Code hooks (.mjs so node can run it un-built; tsx + allowJs
// let the daemon import it type-safely). Used only on the kill path to recover a cost estimate.
import { sumTranscriptTokens } from '../hooks/_lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MC_BIN = process.env.MC_BIN || `node ${join(ROOT, 'bin', 'mc.mjs')}`;

export type McResult = { code: number; ok: boolean; data?: unknown; error?: { code: string; message: string } };
export type Log = (msg: string) => void;

/** Run an mc subcommand (JSON envelope). Never throws — returns the parsed envelope + exit code, so the
 *  caller can branch on the documented codes (0 ok · 1 conflict · 3 not-found, etc.) instead of try/catch. */
export function mc(args: string[], env?: NodeJS.ProcessEnv): Promise<McResult> {
  const [bin, ...binArgs] = MC_BIN.split(' ');
  return new Promise((resolve) => {
    const child = spawn(bin, [...binArgs, ...args, '--json'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      let parsed: { ok?: boolean; data?: unknown; error?: { code: string; message: string } } = {};
      try {
        parsed = JSON.parse(out);
      } catch {
        parsed = { ok: false, error: { code: 'PARSE', message: err.trim() || out.trim() || 'no output' } };
      }
      resolve({ code: code ?? -1, ok: parsed.ok ?? code === 0, data: parsed.data, error: parsed.error });
    });
    child.on('error', (e) => resolve({ code: -1, ok: false, error: { code: 'SPAWN', message: e.message } }));
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Start of the current UTC day as ISO — the window for "today's spend" (matches the spend rollup's UTC day). */
export function startOfUtcDayIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/** This profile's run cost so far today (µ$), via `mc spend --profile`. Only queried when a downgrade is even
 *  possible (budget cap + a fallback model both set) — otherwise it can't matter, so we skip the round-trip.
 *  A spend-lookup failure is non-fatal: assume $0 (don't withhold the primary model on a transient blip). */
export async function profileSpendTodayMicros(profile: AgentProfile, log: Log): Promise<number> {
  if (profile.dailyBudgetMicros == null || !profile.fallbackModel) return 0;
  const r = await mc(['spend', '--profile', profile.slug, '--since', startOfUtcDayIso()]);
  if (!r.ok) {
    log(`spend lookup for profile ${profile.slug} failed (${r.error?.code ?? r.code}) — assuming $0 today`);
    return 0;
  }
  return (r.data as { totals?: { costMicros?: number } } | null)?.totals?.costMicros ?? 0;
}

/** Audit trail for a budget downgrade — the run record already shows the cheaper model; this logs WHY
 *  (budget reached, grounded in real spend) and records a note event on the run. Shared by both daemons so
 *  the wording stays in one place. Call only when choice.downgraded (profile is then guaranteed non-null). */
export async function recordDowngrade(choice: ModelChoice, profile: AgentProfile, spentTodayMicros: number, runId: string, projectSlug: string, log: Log): Promise<void> {
  log(`run ${runId.slice(0, 8)} model downgraded → ${choice.model} (profile ${profile.slug} daily budget reached: ${spentTodayMicros} ≥ ${profile.dailyBudgetMicros} µ$)`);
  await mc(['event', 'add', `Model downgraded to ${choice.model} — profile "${profile.slug}" daily budget reached (${spentTodayMicros} ≥ ${profile.dailyBudgetMicros} µ$)`, '--type', 'note', '--level', 'info', '--run', runId, '--project', projectSlug]);
}

/** A project's ACTIVE Composio connections as MCP servers, fetched via the CLI so DB scope stays at the
 *  mc_agent boundary; the daemon merges them UNDER a profile's own servers at spawn. Non-fatal: a CLI
 *  failure logs and returns undefined so the run still spawns (just without auto-feed). Returns undefined
 *  when there is nothing to add. Shared by both daemons so the command name + log wording live in one place. */
export async function fetchComposioMcpServers(projectSlug: string, runId: string, log: Log): Promise<Record<string, McpServerConfig> | undefined> {
  const cfg = await mc(['mcp', 'config', projectSlug]);
  if (!cfg.ok) {
    log(`mcp config for ${projectSlug} failed (${cfg.error?.code ?? cfg.code}) — spawning without auto-feed`);
    return undefined;
  }
  const servers = (cfg.data as { mcpServers?: Record<string, McpServerConfig> } | null)?.mcpServers;
  const names = Object.keys(servers ?? {}).map((k) => (k.startsWith('composio-') ? k.slice('composio-'.length) : k));
  if (names.length) log(`fed ${names.length} mcp server(s) [${names.join(', ')}] into run ${runId.slice(0, 8)}`);
  return servers;
}

export type Spawned = {
  child: ReturnType<typeof spawn>;
  cleanup: () => void;
  /** Accumulated child stdout (claude-code runtime only; '' for exec / the MC_DAEMON_EXEC stub). The daemon
   *  parses this for claude's authoritative cost via parseResultMetrics. */
  output: () => string;
};

export type AuthoritativeMetrics = {
  costMicros: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** Parse AUTHORITATIVE run metrics from a `claude -p --output-format json` stdout dump: claude's own
 *  `total_cost_usd` (→ micro-dollars) and cumulative token usage. The daemon records these to OVERRIDE the
 *  telemetry hooks' per-message transcript ESTIMATE — the hooks can't see total_cost_usd and mis-price cache
 *  writes (see hooks/pricing.mjs). Scans for the last JSON line carrying total_cost_usd (the result line);
 *  null when there is none (the exec runtime, the MC_DAEMON_EXEC stub, empty, or non-JSON output). */
export function parseResultMetrics(stdout: string): AuthoritativeMetrics | null {
  let result: { total_cost_usd: number; usage?: Record<string, number> } | null = null;
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = JSON.parse(t) as { total_cost_usd?: unknown; usage?: Record<string, number> };
      if (typeof o.total_cost_usd === 'number') result = { total_cost_usd: o.total_cost_usd, usage: o.usage };
    } catch {
      /* not a JSON object line — skip */
    }
  }
  if (!result) return null;
  const u = result.usage ?? {};
  return {
    costMicros: Math.round(result.total_cost_usd * 1e6),
    tokensIn: u.input_tokens || 0,
    tokensOut: u.output_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
    cacheWriteTokens: u.cache_creation_input_tokens || 0,
  };
}

export type SpawnExecutorOpts = {
  prompt: string;
  runId: string;
  repoPath: string;
  profile: AgentProfile | null;
  effectiveModel: string | null;
  basePermissionMode: string;
  /** Extra env merged into the child (e.g. MC_TASK_LABEL/MC_TASK_NOTES for the auto-claim path). */
  extraEnv?: Record<string, string>;
  /** Tools granted on top of the profile's allowedTools (claude-code only) — e.g. the scheduler's Bash(mc:*)
   *  so a check-in can self-serve via the mc CLI. See planSpawn. */
  extraAllowedTools?: string[];
  /** Project-derived Composio MCP servers (from `mc mcp config`), merged UNDER the profile's
   *  own mcpServers (the profile wins a key collision). With no profile they are used as-is (rendered
   *  with --strict-mcp-config, so the profileless agent sees exactly these). */
  extraMcpServers?: Record<string, McpServerConfig>;
  /** Where to TEE the captured claude-code stdout (default process.stdout, keeping the daemon log
   *  unchanged). The workflow runner passes process.stderr so a synchronous `mc workflow run` keeps its
   *  JSON envelope on stdout uncorrupted by the child's result stream. */
  teeStream?: NodeJS.WritableStream;
  /** JSON Schema for structured output (claude-code only) → claude's `--json-schema`. The workflow walker
   *  passes an agent node's responseSchema; the captured result line then carries `structured_output`. */
  jsonSchema?: Record<string, unknown>;
};

/** Pipe a spawned child's stdout into an accumulator AND tee it through to `tee` (so it stays visible in
 *  the daemon log / the CLI's stderr). Returns an `output()` accessor over the accumulated text. Shared by
 *  the claude-code spawn (reads claude's result line) and the MC_DAEMON_EXEC stub (lets a test stub `echo`
 *  a result line — the $0 seam for structured-output / data-passing tests). */
function pipeAndCapture(child: ReturnType<typeof spawn>, tee: NodeJS.WritableStream): () => string {
  let captured = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    captured += s;
    tee.write(s);
  });
  return () => captured;
}

/** Build + spawn the executor as its OWN process group (detached) so we can SIGTERM the whole tree on cancel.
 *  MC_DAEMON_EXEC short-circuits everything (deterministic test seam, no real model). Else: render the
 *  resolved profile (or the daemon default when none) into a claude-code / exec spawn. Returns a cleanup that
 *  removes the MCP-config temp file once the child has exited. THROWS (MissingEnvError) if a profile secret
 *  references a `${ENV}` that is unset — the caller fails the run rather than spawn broken. */
export function spawnExecutor(opts: SpawnExecutorOpts): Spawned {
  const { prompt, runId, repoPath, profile, effectiveModel, basePermissionMode } = opts;
  const baseEnv: NodeJS.ProcessEnv = { ...process.env, MC_RUN_ID: runId, ...opts.extraEnv };
  // The daemon runs under tsx, which propagates its ESM loader to child processes via NODE_OPTIONS so nested
  // `node` stays TypeScript-aware. That MUST NOT leak into the child `claude` — it is a standalone bundled CLI
  // and tsx's loader corrupts its module init (a google-auth `prototype` crash). Hand the executor a clean env.
  delete baseEnv.NODE_OPTIONS;
  const noCleanup = () => {};

  // Enforce the profile's declared skills BEFORE anything spawns — placed above the MC_DAEMON_EXEC stub so the
  // guard is exercised under test too. Resolve each declared skill against the user dir (~/.claude/skills) and
  // the work-dir's .claude/skills; an unresolved one fails the run loudly (MissingSkillError) rather than
  // spawning an agent whose declared capability is silently absent. Only profiles that DECLARE skills are
  // affected — a null profile or an empty skills array does no resolution and gets NO setting-sources pin, so
  // skill-free profiles (the default) keep today's spawn behavior and today's project-settings blast radius.
  let pinSettingSources = false;
  if (profile && profile.skills.length > 0) {
    // Plugin context = enabledPlugins (user ∪ this work-dir's project settings) + the install registry.
    const pluginCtx = loadPluginContext(repoPath);
    const { unresolved } = resolveSkills(profile.skills, {
      dirs: [
        { dir: userSkillsDir(), source: 'user' },
        { dir: join(repoPath, '.claude', 'skills'), source: 'project' },
      ],
      resolvePlugin: (plugin, skill) => pluginSkillStatus(plugin, skill, pluginCtx),
    });
    if (unresolved.length > 0) throw new MissingSkillError(unresolved);
    pinSettingSources = true;
  }

  if (process.env.MC_DAEMON_EXEC) {
    // Capture+tee the stub's stdout (was discarded) so a stub can `echo` a claude-style result line — the
    // seam that makes structured-output / {{ref}} data-passing testable at $0. Teeing to teeStream (stderr
    // for the CLI walker) also keeps a stub's output off the CLI's JSON envelope on stdout.
    const o: SpawnOptions = { cwd: repoPath, env: baseEnv, stdio: ['ignore', 'pipe', 'inherit'], detached: true };
    const child = spawn('sh', ['-c', process.env.MC_DAEMON_EXEC], o);
    return { child, cleanup: noCleanup, output: pipeAndCapture(child, opts.teeStream ?? process.stdout) };
  }

  // Resolve the profile's MCP servers and write them to a 0600 temp file — keeps resolved secrets out of
  // argv (which `ps` would expose). resolveMcpConfigJson may throw MissingEnvError before any file exists.
  let mcpConfigPath: string | null = null;
  let cleanup = noCleanup;
  const mcpJson = resolveMcpConfigJson(mergeMcpServers(profile?.mcpServers, opts.extraMcpServers), process.env);
  if (mcpJson) {
    const path = join(tmpdir(), `mc-mcp-${runId}.json`);
    writeFileSync(path, mcpJson, { mode: 0o600 });
    mcpConfigPath = path;
    cleanup = () => {
      try {
        rmSync(path, { force: true });
      } catch {
        /* best-effort */
      }
    };
  }

  try {
    const plan = planSpawn(profile, { prompt, basePermissionMode, mcpConfigPath, hostEnv: process.env, effectiveModel, extraAllowedTools: opts.extraAllowedTools, jsonSchema: opts.jsonSchema, pinSettingSources });
    const env: NodeJS.ProcessEnv = { ...baseEnv, ...plan.extraEnv };
    // Capture stdout for the claude-code runtime so we can read claude's authoritative result JSON
    // (total_cost_usd + usage + structured_output); tee it through so the daemon log is unchanged. The exec
    // runtime has no such result, so it keeps inheriting. (stderr always inherits → straight to the log.)
    const capture = plan.runtime === 'claude-code';
    const o: SpawnOptions = { cwd: repoPath, env, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'], detached: true };
    const child = spawn(plan.bin, plan.args, o);
    const output = capture ? pipeAndCapture(child, opts.teeStream ?? process.stdout) : () => '';
    return { child, cleanup, output };
  } catch (e) {
    cleanup(); // env-placeholder resolution failed after the temp file was written — don't leak it
    throw e;
  }
}

const KILL_AFTER_TERM_SEC = 5; // SIGTERM → (this long to flush) → SIGKILL

/** Wait for the child to exit while watching for operator cancel + a wall-clock timeout. Cancel gives the
 *  cooperative kill-switch hook `graceSec` to halt the child between tool calls before the OS-signal backstop;
 *  a timeout SIGTERMs immediately (a wedged child has no cooperative path). The SIGTERM→SIGKILL escalation is
 *  TIMER-driven (not quantized to the poll tick) and targets the child's whole process group. */
export async function monitorChild(
  child: ReturnType<typeof spawn>,
  runId: string,
  opts: { timeoutSec: number; graceSec: number },
  log: Log,
): Promise<{ exitCode: number | null; cancelled: boolean; timedOut: boolean }> {
  const pgid = child.pid ? -child.pid : null;
  const killGroup = (sig: NodeJS.Signals) => {
    if (!pgid) return;
    try {
      process.kill(pgid, sig);
    } catch {
      /* group already gone */
    }
  };
  let cancelled = false;
  let timedOut = false;
  let escalating = false;
  const timers: NodeJS.Timeout[] = [];
  const escalate = (graceSec: number) => {
    if (escalating) return;
    escalating = true;
    timers.push(setTimeout(() => killGroup('SIGTERM'), graceSec * 1000));
    timers.push(setTimeout(() => killGroup('SIGKILL'), (graceSec + KILL_AFTER_TERM_SEC) * 1000));
  };

  const startedAt = Date.now();
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

  while ((await Promise.race([exited.then(() => 'exit' as const), sleep(2000).then(() => 'tick' as const)])) === 'tick') {
    // One lean call per tick does double duty: it BUMPS lastHeartbeatAt (so a long-running tool call — a
    // multi-minute build/test, the product's normal workload — can't go heartbeat-stale and get falsely
    // abandoned by the reaper, releasing its claimed task mid-work) AND returns cancel_requested for the
    // kill-switch. `run heartbeat` is gated on status='running' and skips the 501-event fetch `run get` did.
    const r = await mc(['run', 'heartbeat', runId]);
    if (!cancelled && (r.data as { cancelRequested?: boolean } | null)?.cancelRequested) {
      cancelled = true;
      log(`run ${runId.slice(0, 8)} cancel_requested — kill-switch hook gets ${opts.graceSec}s, then SIGTERM→SIGKILL`);
      escalate(opts.graceSec); // cooperative grace before the OS-signal backstop
    }
    if (!timedOut && (Date.now() - startedAt) / 1000 > opts.timeoutSec) {
      timedOut = true;
      log(`run ${runId.slice(0, 8)} exceeded ${opts.timeoutSec}s timeout — SIGTERM now, SIGKILL in ${KILL_AFTER_TERM_SEC}s`);
      escalate(0); // wedged child, no cooperative path → terminate immediately
    }
  }

  timers.forEach(clearTimeout);
  return { exitCode: await exited, cancelled, timedOut };
}

/** After the child exits, YIELD to its Stop hook — that hook posts run.end with the real transcript token/cost
 *  totals (which feed the spend rollup). Poll briefly; as soon as the run is terminal the hook won, so keep its
 *  totals. Only if it never lands (an executor without our hooks, or a failed post) does the daemon close the
 *  run itself — so there is a single authoritative run.end per run, and the recordRunEnd cancel-guard handles
 *  the cancel case regardless of who writes it. */
export async function finalize(runId: string, exitCode: number | null, cancelled: boolean, log: Log): Promise<string> {
  for (let i = 0; i < 4; i++) {
    await sleep(2000);
    const r = await mc(['run', 'get', runId]);
    const run = r.data as { status?: string } | null;
    if (run && run.status && run.status !== 'running') return run.status; // the Stop hook (or cancel path) already ended it
  }
  const status = cancelled ? 'abandoned' : exitCode === 0 ? 'completed' : 'failed';
  await mc(['run', 'end', runId, status]); // cancel-guard coerces completed→abandoned if cancel_requested
  log(`run ${runId.slice(0, 8)} closed by daemon → ${status}`);
  return status;
}

/** The shared spawn TAIL both daemons run after a successful spawnExecutor: watch the child (cancel +
 *  timeout), remove the MCP temp file, then yield-or-close the run. Returns the terminal status plus the raw
 *  exit signals so the caller can log/branch (e.g. the scheduler records ok/fail). */
export async function monitorAndFinalize(
  spawned: Spawned,
  runId: string,
  opts: { timeoutSec: number; graceSec: number },
  log: Log,
): Promise<{ status: string; exitCode: number | null; cancelled: boolean; timedOut: boolean }> {
  const { exitCode, cancelled, timedOut } = await monitorChild(spawned.child, runId, opts, log);
  spawned.cleanup(); // remove the MCP-config temp file now the child has exited
  // AUTHORITATIVE cost is a claude-code-only capability: only `claude -p --output-format json` emits a result
  // line with total_cost_usd, so parseResultMetrics is non-null only there (exec runtime + the MC_DAEMON_EXEC
  // stub → null → keep the hook estimate / daemon-close path below).
  const metrics = parseResultMetrics(spawned.output());
  const status = await finalize(runId, exitCode, cancelled || timedOut, log);
  if (metrics) {
    // Override the hooks' transcript ESTIMATE with claude's own total_cost_usd + usage. --authoritative SETs the
    // metrics exactly (the normal GREATEST guard would keep the higher, wrong estimate). Ordering is safe — this
    // write is deterministically LAST: Claude Code runs the Stop hook synchronously (it `await`s its run.end POST
    // before the hook exits, and claude waits for the hook before exiting), so the estimate has already landed by
    // the time monitorChild observes exit and we post here. The run.ended event + terminalize are idempotent.
    const r = await mc(['run', 'end', runId, status, '--authoritative',
      '--cost-micros', String(metrics.costMicros), '--tokens-in', String(metrics.tokensIn),
      '--tokens-out', String(metrics.tokensOut), '--cache-read', String(metrics.cacheReadTokens),
      '--cache-write', String(metrics.cacheWriteTokens)]);
    if (r.ok) log(`recorded authoritative cost $${(metrics.costMicros / 1e6).toFixed(4)} for run ${runId.slice(0, 8)}`);
    else log(`authoritative cost post failed for run ${runId.slice(0, 8)} (${r.error?.code ?? r.code}) — estimate stands`);
  } else if (cancelled || timedOut) {
    // A killed child (cancel/timeout → SIGTERM→SIGKILL) prints no `--output-format json` result line and
    // runs no Stop hook, so parseResultMetrics is null and the run would record $0 forever — undercounting
    // the spend rollup AND the daily-budget downgrade (a profile whose runs keep timing out never trips its
    // cap). Recover a best-effort estimate from the transcript the SessionStart hook stored on the run.
    await recoverKilledRunCost(runId, status, log);
  }
  return { status, exitCode, cancelled, timedOut };
}

/** Best-effort cost recovery for a killed run (M12). Reads the run's transcriptRef (recorded by the
 *  SessionStart hook) and sums per-message token/cost from the .jsonl, then records it NON-authoritatively
 *  (server-side GREATEST guard; the M11 terminal-status gate keeps the run terminal — only metrics advance).
 *  No-op when there's no transcript (exec runtime / hooks not installed) or nothing to record. */
async function recoverKilledRunCost(runId: string, status: string, log: Log): Promise<void> {
  const r = await mc(['run', 'get', runId]);
  const ref = (r.data as { transcriptRef?: string | null } | null)?.transcriptRef;
  if (!ref) return;
  const t = sumTranscriptTokens(ref);
  if (!t.costMicros && !t.tokensIn && !t.tokensOut) return;
  const res = await mc(['run', 'end', runId, status,
    '--cost-micros', String(t.costMicros), '--tokens-in', String(t.tokensIn), '--tokens-out', String(t.tokensOut),
    '--cache-read', String(t.cacheReadTokens), '--cache-write', String(t.cacheWriteTokens)]);
  if (res.ok) log(`recovered ~$${(t.costMicros / 1e6).toFixed(4)} from transcript for killed run ${runId.slice(0, 8)}`);
  else log(`transcript-cost recovery failed for run ${runId.slice(0, 8)} (${res.error?.code ?? res.code})`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // alive but owned by another user
  }
}

/** Directory for daemon lockfiles. Honors MC_LOCK_DIR so a test-spawned daemon can take a throwaway lock in a
 *  mkdtemp dir instead of contending with a long-running production daemon on the shared per-user $TMPDIR
 *  lock — the collision that made `npm test` fail whenever the always-on scheduler service was running (M22). */
export function lockDir(): string {
  return process.env.MC_LOCK_DIR || tmpdir();
}

/** Single-instance lock at `lockPath`. A stale lock (dead holder pid) is taken over; a live holder makes us
 *  refuse to start (exit 1) with `descr` in the message. Returns a release fn. Used per-repo by auto-claim and
 *  globally by the scheduler. */
export function acquireLock(lockPath: string, descr: string): () => void {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); // exclusive create — fails if it exists
  } catch {
    let holder = 0;
    try {
      holder = Number(readFileSync(lockPath, 'utf8').trim());
    } catch {
      /* unreadable */
    }
    if (holder && isAlive(holder)) {
      console.error(`another instance (pid ${holder}) already owns ${descr} — refusing to start a second instance`);
      process.exit(1);
    }
    writeFileSync(lockPath, String(process.pid)); // stale lock (dead holder) → take it over
  }
  return () => {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* best-effort */
    }
  };
}

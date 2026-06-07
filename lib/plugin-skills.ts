// ABOUTME: Plugin-source skill resolver — the plugin twin of lib/skills.ts. Resolves/enumerates Claude Code
// ABOUTME: PLUGIN skills (declared `<plugin>:<skill>`, e.g. compound-engineering:ce-work), which are gated by
// ABOUTME: `enabledPlugins` in .claude/settings.json (NOT a .claude/skills scan) and live at the version-pinned
// ABOUTME: install paths in ~/.claude/plugins/installed_plugins.json. Path-injectable via MC_CLAUDE_HOME for
// ABOUTME: tests. Scope: the plugin mechanism ONLY — not a generic multi-source extension point. No DB, no spawn.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { claudeHome, parseSkillFrontmatter } from './skills';

/** A name segment (plugin or marketplace or skill) — the same flat, traversal-safe token lib/skills.ts uses. */
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

export type PluginSkillReason = 'plugin-disabled' | 'plugin-not-installed' | 'skill-not-found';

/** Enabled plugins: plugin name → the set of marketplaces in which it is enabled (`enabledPlugins[k]===true`). */
export type EnabledPlugins = Map<string, Set<string>>;

export type InstalledEntry = { marketplace: string; installPath: string };

/** Installed plugins: plugin name → its install entries (one per marketplace), each carrying the install path. */
export type InstalledPlugins = Map<string, InstalledEntry[]>;

/** The resolved plugin world a single resolution/enumeration reads against. */
export type PluginContext = { enabled: EnabledPlugins; installed: InstalledPlugins };

export type PluginSkillStatus = { resolved: boolean; marketplace?: string; reason?: PluginSkillReason };

/** A discovered plugin skill, addressed by its `<plugin>:<skill>` namespace. Field names are canonical — the
 *  CLI emits them verbatim. */
export type PluginSkillInfo = {
  name: string; // `<plugin>:<skill>`
  description: string;
  source: 'plugin';
  plugin: string;
  marketplace: string;
};

// ── Paths (all under claudeHome(), so MC_CLAUDE_HOME redirects them in tests) ─────────────────────────────

export function userSettingsPath(): string {
  return join(claudeHome(), 'settings.json');
}

export function installedPluginsPath(): string {
  return join(claudeHome(), 'plugins', 'installed_plugins.json');
}

/** A project work-dir's settings (the `project` half of the user∪project enablement union). */
export function projectSettingsPath(repoPath: string): string {
  return join(repoPath, '.claude', 'settings.json');
}

/** The directory every install path must live under — a tampered/symlinked `installPath` outside it is rejected. */
function pluginsRoot(): string {
  return resolve(join(claudeHome(), 'plugins'));
}

// ── Readers (best-effort: a missing/malformed file or entry contributes nothing, never throws) ───────────

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Split a `<plugin>@<marketplace>` key, validating BOTH segments. Returns null on a malformed/crafted key
 *  (no `@`, multiple `@`, or a segment with path-significant characters) so it is silently skipped. */
function splitPluginKey(key: string): { plugin: string; marketplace: string } | null {
  const parts = key.split('@');
  if (parts.length !== 2) return null;
  const [plugin, marketplace] = parts;
  if (!SEGMENT_RE.test(plugin) || !SEGMENT_RE.test(marketplace)) return null;
  return { plugin, marketplace };
}

/** Union the `enabledPlugins` maps (only `true` entries) across the given settings files (user ∪ project). */
export function readEnabledPlugins(settingsPaths: string[]): EnabledPlugins {
  const out: EnabledPlugins = new Map();
  for (const path of settingsPaths) {
    const doc = readJson(path) as { enabledPlugins?: Record<string, unknown> } | undefined;
    const map = doc?.enabledPlugins;
    if (!map || typeof map !== 'object') continue;
    for (const [key, val] of Object.entries(map)) {
      if (val !== true) continue;
      const parsed = splitPluginKey(key);
      if (!parsed) continue;
      const set = out.get(parsed.plugin) ?? new Set<string>();
      set.add(parsed.marketplace);
      out.set(parsed.plugin, set);
    }
  }
  return out;
}

/** Is `installPath` absolute AND under the plugins root? Lexical `resolve` blocks `..`/elsewhere escapes; a
 *  best-effort `realpathSync` additionally blocks symlink escapes when the path exists. */
function isUnderPluginsRoot(installPath: string): boolean {
  if (!isAbsolute(installPath)) return false;
  const root = pluginsRoot();
  const within = (p: string, base: string) => p === base || p.startsWith(base + '/');
  if (!within(resolve(installPath), root)) return false; // lexical: blocks `..` / elsewhere escapes
  // Symlink check — realpath BOTH sides on the same basis (macOS tmp is a /var → /private/var symlink, so
  // comparing a realpath'd installPath against a non-realpath'd root would spuriously reject).
  try {
    const realRoot = (() => {
      try {
        return realpathSync(root);
      } catch {
        return root;
      }
    })();
    return within(realpathSync(installPath), realRoot);
  } catch {
    return true; // path doesn't exist yet / not a symlink — lexical check already passed
  }
}

/** Read the install registry, keyed by plugin name. Rejects any entry whose `installPath` is non-absolute or
 *  escapes the plugins root. The top-level `version` field is ignored. */
export function readInstalledPlugins(installedPluginsPath: string): InstalledPlugins {
  const out: InstalledPlugins = new Map();
  const doc = readJson(installedPluginsPath) as { plugins?: Record<string, unknown> } | undefined;
  const plugins = doc?.plugins;
  if (!plugins || typeof plugins !== 'object') return out;
  let entryCount = 0;
  for (const [key, entries] of Object.entries(plugins)) {
    const parsed = splitPluginKey(key);
    if (!parsed || !Array.isArray(entries)) continue;
    for (const e of entries) {
      const installPath = (e as { installPath?: unknown })?.installPath;
      if (typeof installPath !== 'string' || !isUnderPluginsRoot(installPath)) continue;
      const list = out.get(parsed.plugin) ?? [];
      list.push({ marketplace: parsed.marketplace, installPath });
      out.set(parsed.plugin, list);
      entryCount++;
    }
  }
  // A clean parse yielding nothing on a populated system usually means a schema bump — surface it loudly.
  if (entryCount === 0 && plugins && Object.keys(plugins).length > 0) {
    console.warn(`[plugin-skills] installed_plugins.json parsed but yielded 0 usable entries (schema change?)`);
  }
  return out;
}

/** Build the plugin world from real paths (the daemon/CLI entry point). `repoPath` adds the project settings
 *  half of the enablement union; pass null to read user settings only. */
export function loadPluginContext(repoPath?: string | null): PluginContext {
  const settingsPaths = [userSettingsPath()];
  if (repoPath) settingsPaths.push(projectSettingsPath(repoPath));
  return {
    enabled: readEnabledPlugins(settingsPaths),
    installed: readInstalledPlugins(installedPluginsPath()),
  };
}

// ── The shared predicate (catalog + resolution both call this — preserves R7/R8) ─────────────────────────

/** Does `<installPath>/skills/<skill>/SKILL.md` exist? */
function pluginSkillFilePresent(installPath: string, skill: string): boolean {
  return existsSync(join(installPath, 'skills', skill, 'SKILL.md'));
}

/** Marketplaces that are BOTH enabled and installed for `plugin`, sorted for deterministic selection. */
function intersectMarketplaces(plugin: string, ctx: PluginContext): InstalledEntry[] {
  const enabled = ctx.enabled.get(plugin) ?? new Set<string>();
  const installed = ctx.installed.get(plugin) ?? [];
  return installed.filter((e) => enabled.has(e.marketplace)).sort((a, b) => a.marketplace.localeCompare(b.marketplace));
}

/** Resolve a single `<plugin>:<skill>` reference. Intersects on marketplace (a marketplace must be BOTH
 *  enabled AND installed), then checks for the skill file; classifies the precise failure reason otherwise. */
export function pluginSkillStatus(plugin: string, skill: string, ctx: PluginContext): PluginSkillStatus {
  const enabled = ctx.enabled.get(plugin) ?? new Set<string>();
  const installed = ctx.installed.get(plugin) ?? [];
  if (enabled.size === 0) {
    return { resolved: false, reason: installed.length > 0 ? 'plugin-disabled' : 'plugin-not-installed' };
  }
  const candidates = intersectMarketplaces(plugin, ctx);
  if (candidates.length === 0) return { resolved: false, reason: 'plugin-not-installed' };
  for (const c of candidates) {
    if (pluginSkillFilePresent(c.installPath, skill)) return { resolved: true, marketplace: c.marketplace };
  }
  return { resolved: false, reason: 'skill-not-found' };
}

// ── Catalog enumeration (shares the marketplace-intersection + file-presence logic above) ────────────────

/** Best-effort description for a plugin skill's SKILL.md — never throws (a malformed one lists with ''). */
function readDescription(installPath: string, skill: string): string {
  const file = join(installPath, 'skills', skill, 'SKILL.md');
  try {
    return parseSkillFrontmatter(readFileSync(file, 'utf8'), file).description;
  } catch {
    return '';
  }
}

/** Enumerate every resolvable plugin skill (R7) — for each enabled+installed marketplace, list its `skills/`
 *  subdirs that carry a SKILL.md. Deduped by `<plugin>:<skill>` (first enabled+installed marketplace wins,
 *  marketplaces visited in sorted order). The set returned equals what `pluginSkillStatus` would resolve. */
export function scanPluginSkills(ctx: PluginContext): PluginSkillInfo[] {
  const seen = new Set<string>();
  const out: PluginSkillInfo[] = [];
  for (const plugin of ctx.enabled.keys()) {
    for (const { marketplace, installPath } of intersectMarketplaces(plugin, ctx)) {
      let skillDirs: string[];
      try {
        skillDirs = readdirSync(join(installPath, 'skills'), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        continue; // no skills/ dir
      }
      for (const skill of skillDirs) {
        const name = `${plugin}:${skill}`;
        if (seen.has(name) || !SEGMENT_RE.test(skill) || !pluginSkillFilePresent(installPath, skill)) continue;
        seen.add(name);
        out.push({ name, description: readDescription(installPath, skill), source: 'plugin', plugin, marketplace });
      }
    }
  }
  return out;
}

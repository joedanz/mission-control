'use server';

// ABOUTME: Server actions for all mutations. EVERY action calls requireAllowedUser() first.
// ABOUTME: Thin wrappers — they parse FormData (coerce-to-default), delegate writes to lib/mutations,
// ABOUTME: then revalidate. The DB logic itself lives in lib/mutations.ts (shared with the CLI).

import { revalidatePath } from 'next/cache';
import { requireAllowedUser } from '@/lib/authz';
import { withActor } from '@/lib/actor-context';
import { ConflictError, ValidationError } from '@/lib/validation';
import * as mutations from '@/lib/mutations';
import type { ProjectInput } from '@/lib/mutations';
import { scanForLeakedSecrets, type ProfileInput } from '@/lib/profiles';
import {
  CATEGORIES,
  STATUSES,
  ACCENTS,
  PRIORITIES,
  type Category,
  type Status,
  type Accent,
  type Priority,
} from '@/lib/db/schema';

function str(form: FormData, key: string): string {
  return String(form.get(key) ?? '').trim();
}

function nullable(form: FormData, key: string): string | null {
  const v = str(form, key);
  return v === '' ? null : v;
}

/** Parse a project FormData into a typed input, coercing invalid enums to defaults (web policy). */
function parseProjectForm(form: FormData): ProjectInput {
  const name = str(form, 'name');
  if (!name) throw new Error('Name is required');

  const category = str(form, 'category');
  const status = str(form, 'status');
  const accent = str(form, 'accent');
  const priority = str(form, 'priority');

  return {
    name,
    category: (CATEGORIES as readonly string[]).includes(category) ? (category as Category) : 'internal',
    status: (STATUSES as readonly string[]).includes(status) ? (status as Status) : 'prelaunch',
    accent: (ACCENTS as readonly string[]).includes(accent) ? (accent as Accent) : 'orange',
    domain: nullable(form, 'domain'),
    techStack: str(form, 'techStack').split(',').map((s) => s.trim()).filter(Boolean),
    repoPath: nullable(form, 'repoPath'),
    repoUrl: nullable(form, 'repoUrl'),
    liveUrl: nullable(form, 'liveUrl'),
    priority: (PRIORITIES as readonly string[]).includes(priority) ? (priority as Priority) : null,
    notes: nullable(form, 'notes'),
  };
}

/** Auth + bind the signed-in user as the event actor (kind:'human'), then run `fn` against the
 *  mutation core. The single auth+attribution seam for every web action — returns fn's result so
 *  callers can gate revalidation on it. */
async function asUser<T>(fn: (m: typeof mutations) => Promise<T>): Promise<T> {
  const { user } = await requireAllowedUser();
  return withActor({ label: user.email, kind: 'human' }, () => fn(mutations));
}

// ── Projects ──────────────────────────────────────────────────────────────────
export async function createProject(form: FormData) {
  await asUser((m) => m.createProject(parseProjectForm(form)));
  revalidatePath('/', 'layout');
}

export async function updateProject(id: string, form: FormData) {
  await asUser((m) => m.updateProject(id, parseProjectForm(form)));
  revalidatePath('/', 'layout');
}

export async function deleteProject(id: string) {
  await asUser((m) => m.deleteProject(id)); // tasks cascade
  revalidatePath('/', 'layout');
}

export async function setProjectRepo(id: string, repoPath: string, repoUrl: string) {
  await asUser((m) => m.setProjectRepo(id, repoPath.trim() || null, repoUrl.trim() || null));
  revalidatePath('/', 'layout');
}

// ── Tasks ───────────────────────────────────────────────────────────────────--
export async function addTask(projectId: string, label: string) {
  const trimmed = label.trim();
  if (!trimmed) return;
  await asUser((m) => m.addTask(projectId, trimmed));
  revalidatePath('/', 'layout');
}

export async function toggleTask(taskId: string) {
  const updated = await asUser((m) => m.toggleTask(taskId));
  if (updated) revalidatePath('/', 'layout');
}

export async function deleteTask(taskId: string) {
  await asUser((m) => m.deleteTask(taskId));
  revalidatePath('/', 'layout');
}

/** Board drag: change a task's status and/or reindex its column. Returns whether the write landed so the
 *  client can revert an optimistic move on a version conflict / live-claim refusal (moveTask → null). */
export async function moveTask(
  id: string,
  opts: { toStatus?: string; orderedIds?: string[]; expectedVersion?: number },
): Promise<{ ok: boolean }> {
  const moved = await asUser((m) => m.moveTask(id, opts as Parameters<typeof m.moveTask>[1]));
  if (moved) revalidatePath('/', 'layout');
  return { ok: !!moved };
}

// ── Runs ────────────────────────────────────────────────────────────────────--
/** Operator kill-switch (write half): flag a running run for cancellation. Enforced by the PreToolUse
 *  kill-switch hook on the run's own machine when installed (PR #22) — its next heartbeat caches the flag
 *  and the hook halts the run's next tool call; without the hook wired this is just the flag + badge.
 *  The Stop button only renders for live runs, but a run can terminate between render and click;
 *  that benign race surfaces as ConflictError, which we swallow (the run already ended — intent is moot)
 *  while still revalidating so the UI reflects reality. */
export async function requestRunCancel(runId: string) {
  try {
    await asUser((m) => m.setRunCancelRequested(runId));
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
  }
  revalidatePath('/', 'layout');
}

// ── Agent profiles ──────────────────────────────────────────────────────────────
/** A profile write either lands or returns the validation/conflict reason for the editor to show. We catch
 *  only the EXPECTED errors (bad enum/regex/missing exec template; duplicate slug; second default) so the
 *  rich form can surface them inline; anything unexpected still bubbles. The mutation field-scopes the insert,
 *  so passing the structured `input` object (nested mcp/matchRules don't fit FormData) carries no mass-assign risk. */
export type ProfileActionResult = { ok: true } | { ok: false; error: string };

function profileWriteError(err: unknown): ProfileActionResult {
  if (err instanceof ValidationError || err instanceof ConflictError) return { ok: false, error: err.message };
  throw err;
}

/** The "secrets are placeholders, NEVER stored" contract is enforced softly on the CLI (a stderr warning).
 *  The web editor has no such channel, so it would SILENTLY persist a raw secret. Block the write and report
 *  the offending field(s) so the user switches to a ${ENV} placeholder. */
function secretLeakError(input: ProfileInput): ProfileActionResult | null {
  const leaks = scanForLeakedSecrets(input);
  return leaks.length ? { ok: false, error: leaks.join('; ') } : null;
}

export async function createProfile(input: ProfileInput): Promise<ProfileActionResult> {
  const leak = secretLeakError(input);
  if (leak) return leak;
  try {
    await asUser((m) => m.createProfile(input));
  } catch (err) {
    return profileWriteError(err);
  }
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function updateProfile(id: string, input: ProfileInput): Promise<ProfileActionResult> {
  const leak = secretLeakError(input);
  if (leak) return leak;
  try {
    await asUser((m) => m.updateProfile(id, input));
  } catch (err) {
    return profileWriteError(err);
  }
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function deleteProfile(id: string) {
  await asUser((m) => m.deleteProfile(id)); // runs that used it keep their row (FK SET NULL)
  revalidatePath('/', 'layout');
}

export async function setDefaultProfile(id: string) {
  await asUser((m) => m.setDefaultProfile(id)); // clears every other default first (single-default index)
  revalidatePath('/', 'layout');
}

/** Enable/disable without opening the editor — a partial update (only `enabled` is written). */
export async function setProfileEnabled(id: string, enabled: boolean) {
  await asUser((m) => m.updateProfile(id, { enabled }));
  revalidatePath('/', 'layout');
}

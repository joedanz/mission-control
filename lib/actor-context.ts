// ABOUTME: AsyncLocalStorage actor context so recordEvent() can attribute events without
// ABOUTME: threading a ctx param through every mutation signature. No Next/server-only imports —
// ABOUTME: safe to import from lib/mutations.ts (shared by the web app, the CLI, and the ingest route).

import { AsyncLocalStorage } from 'node:async_hooks';

export type ActorKind = 'human' | 'agent' | 'system';

export type Actor = {
  /** Free-text label: a human's email, an agent label ('claude-code', 'cc'), or 'system'. */
  label: string;
  kind?: ActorKind;
  /** The run this actor's work belongs to, if any — used as the default event.runId. */
  runId?: string | null;
};

const storage = new AsyncLocalStorage<Actor>();

/** Run `fn` with `actor` bound for any recordEvent() calls inside it (including awaited ones).
 *  Merges over any enclosing actor, so a nested scope that only sets `label` still inherits the
 *  outer `runId` (e.g. the CLI's base run id) instead of dropping it. */
export function withActor<T>(actor: Actor, fn: () => T): T {
  const merged: Actor = { ...storage.getStore(), ...actor };
  return storage.run(merged, fn);
}

/** The currently-bound actor, or null when none is set (e.g. seed/link-repos scripts).
 *  recordEvent() falls back to a 'system' label in that case — a missing actor is never an error. */
export function getActor(): Actor | null {
  return storage.getStore() ?? null;
}

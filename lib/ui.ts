// ABOUTME: Pure presentation helpers shared by server components.
// ABOUTME: Color is status signal — `statusTone` maps a project status to one instrument tone.

import type { ProjectWithTasks } from './queries';
import type { Task } from './db/schema';

export type Tone = 'ok' | 'warn' | 'info' | 'violet';

const STATUS_TONE: Record<string, Tone> = {
  prelaunch: 'warn',
  launched: 'ok',
  active: 'ok',
  testing: 'info',
  design: 'violet',
  planning: 'violet',
};

/** Instrument tone for a project status (drives the row tick + status pill color). */
export function statusTone(status: string): Tone {
  return STATUS_TONE[status] ?? 'warn';
}

const STATUS_LABELS: Record<string, string> = {
  prelaunch: 'Pre-launch',
  launched: 'Launched',
  testing: 'Testing',
  active: 'Active',
  design: 'Design',
  planning: 'Planning',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** Category display: full label (palette/menus), short label (table chip), and tone (chip color). */
const CATEGORY_LABELS: Record<string, string> = {
  internal: 'Internal',
  open_source: 'Open Source',
  client: 'Client',
};
const CATEGORY_SHORT: Record<string, string> = {
  internal: 'Internal',
  open_source: 'OSS',
  client: 'Client',
};
const CATEGORY_TONE: Record<string, Tone> = {
  internal: 'warn',
  open_source: 'violet',
  client: 'info',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}
export function categoryShort(category: string): string {
  return CATEGORY_SHORT[category] ?? category;
}
export function categoryTone(category: string): Tone {
  return CATEGORY_TONE[category] ?? 'info';
}

/** Compact relative time ("now", "5m", "3h", "2d", "3w", "4mo", "2y") for the Updated column. */
export function relativeTime(date: Date | string): string {
  const then = typeof date === 'string' ? new Date(date) : date;
  const secs = Math.max(0, Math.floor((Date.now() - then.getTime()) / 1000));
  if (secs < 60) return 'now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (days < 365) return `${months}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Absolute, compact local timestamp ("May 29, 03:14 PM") for appointment-style times (run metadata, a
 *  check-in's next fire). Returns '—' for an unparseable date. Pairs with relativeTime (recency). */
export function formatShortDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Format integer micro-dollars as a compact cost string for the Mission strip. '' when 0/absent so
 *  callers can omit it; '<$0.01' for sub-cent spend; else `$X.XX`. */
export function formatCost(costMicros: number | null | undefined): string {
  if (!costMicros || costMicros <= 0) return '';
  const dollars = costMicros / 1_000_000;
  if (dollars < 0.01) return '<$0.01';
  return `$${dollars.toFixed(2)}`;
}

/** Always-present dollar figure for rollup/total readouts (unlike `formatCost`, never returns ''):
 *  thousands-separated, 2dp. Takes integer micro-dollars. */
export function formatDollars(costMicros: number | null | undefined): string {
  const dollars = (costMicros ?? 0) / 1_000_000;
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Thousands-separated integer (token totals, run counts) for dense numeric readouts. */
export function formatTokens(n: number | null | undefined): string {
  return Math.round(n ?? 0).toLocaleString('en-US');
}

/** Instrument tone token for an activity event row (the `data-tone` attr): severity wins, then the
 *  type prefix. A wider set than `Tone` — adds 'bad'/'neutral' — shared by the Mission feed and the
 *  per-run event timeline so the mapping lives in one place. */
export function eventTone(level: string, type: string): 'bad' | 'warn' | 'violet' | 'ok' | 'info' | 'neutral' {
  if (level === 'error') return 'bad';
  if (level === 'warn') return 'warn';
  if (type.startsWith('run.')) return 'violet';
  if (type.startsWith('task.')) return 'ok';
  if (type.startsWith('integration.')) return 'info';
  if (type.startsWith('project.')) return 'info';
  return 'neutral';
}

/** Tone token for an agent run row/badge: live → ok, failed/abandoned → bad, else neutral.
 *  Shared by the Fleet strip and the run drill-in (both pass a row with `live` + `status`). */
export function runTone(run: { live: boolean; status: string }): 'ok' | 'bad' | 'neutral' {
  if (run.live) return 'ok';
  if (run.status === 'failed' || run.status === 'abandoned') return 'bad';
  return 'neutral';
}

export function isTaskDone(t: Task): boolean {
  return t.integrationType ? t.integrationStatus === 'done' : t.status === 'done';
}

/** The state word shown for a task: its integration status (default 'needed') or its workflow status. */
export function taskState(t: Task): string {
  return t.integrationType ? (t.integrationStatus ?? 'needed') : t.status;
}

/** Count of incomplete tasks; the row badge hides this when zero. */
export function incompleteCount(p: ProjectWithTasks): number {
  return p.tasks.filter((t) => !isTaskDone(t)).length;
}

/** Per-project integration state for the inline row chips (null = project lacks that task). */
export function integrationStatusOf(
  p: ProjectWithTasks,
  type: 'sentry' | 'zoho_email',
): 'done' | 'pending' | 'needed' | null {
  const task = p.tasks.find((t) => t.integrationType === type);
  if (!task) return null;
  const s = task.integrationStatus ?? 'needed';
  return s === 'done' || s === 'pending' ? s : 'needed';
}

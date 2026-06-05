'use client';

// ABOUTME: Profiles section client view — the list of profiles + the New/Edit modal + inline row controls
// ABOUTME: (set default, enable/disable, delete). Server-fetched `profiles` arrive as a prop; mutations run
// ABOUTME: through the server actions (which revalidate the route, re-rendering this with fresh data).

import { useState, useTransition } from 'react';
import { deleteProfile, setDefaultProfile, setProfileEnabled } from '@/app/actions';
import type { AgentProfile } from '@/lib/db/schema';
import { relativeTime, formatShortDateTime } from '@/lib/ui';
import { SCHEDULE_MAX_FAILURES } from '@/lib/constants';
import { ProfileModal, type ProjectOption } from './ProfileModal';

/** A one-line human summary of a profile's auto-routing rules (or its default/none status). */
function matchSummary(p: AgentProfile): string {
  if (p.isDefault) return 'Default — used when no rule matches';
  const r = p.matchRules;
  if (!r) return 'No match rules (never auto-selected)';
  const parts: string[] = [];
  if (r.projectSlugs?.length) parts.push(`projects: ${r.projectSlugs.join(', ')}`);
  if (r.projectCategories?.length) parts.push(`categories: ${r.projectCategories.join(', ')}`);
  if (r.labelPattern) parts.push(`label ~ /${r.labelPattern}/`);
  return parts.length ? parts.join(' · ') : 'No match rules (never auto-selected)';
}

/** A one-line human summary of a profile's scheduled check-in (trigger + bound project). */
function scheduleSummary(p: AgentProfile, projectSlug: string | null): string {
  const trigger = p.scheduleCron
    ? `cron ${p.scheduleCron}`
    : p.scheduleIntervalSec != null
      ? `every ${p.scheduleIntervalSec}s`
      : 'no trigger set';
  return projectSlug ? `${trigger} → ${projectSlug}` : trigger;
}

const hasScheduleConfig = (p: AgentProfile): boolean =>
  !!p.scheduleProjectId && (p.scheduleIntervalSec != null || !!p.scheduleCron);

/** A schedule that the daemon turned OFF after hitting the failure threshold — distinct from a profile that
 *  was never scheduled or manually disabled. This is the signal that was previously invisible in the UI. */
const isAutoPaused = (p: AgentProfile): boolean =>
  !p.scheduleEnabled && hasScheduleConfig(p) && p.consecutiveFailures >= SCHEDULE_MAX_FAILURES;

function ProfileRow({ p, projectSlug, nextRunAt, onEdit }: { p: AgentProfile; projectSlug: string | null; nextRunAt: string | null; onEdit: () => void }) {
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<unknown>) => startTransition(() => void fn());
  const mcpNames = Object.keys(p.mcpServers ?? {});
  const autoPaused = isAutoPaused(p);
  const ago = p.lastCheckInAt ? relativeTime(p.lastCheckInAt) : null;
  const checkedInLabel = ago === null ? 'never run yet' : ago === 'now' ? 'checked in just now' : `checked in ${ago} ago`;

  return (
    <details className="row prow">
      <summary className="row-head prow-head">
        <span className={`row-tick ${p.enabled ? 'ok' : ''}`} aria-hidden="true" />
        <span className="prow-name">
          <span className="row-name">{p.name}</span>
          <span className="row-domain">{p.slug}</span>
        </span>
        <span className={`cat-chip ${p.runtime === 'exec' ? 'violet' : 'info'}`}>{p.runtime}</span>
        <span className="prow-model">{p.model ?? '—'}</span>
        <span className="prow-badges">
          {p.isDefault && <span className="pbadge default">DEFAULT</span>}
          {p.scheduleEnabled && <span className="pbadge sched">SCHEDULED</span>}
          {autoPaused && <span className="pbadge paused">PAUSED</span>}
          {!p.enabled && <span className="pbadge off">DISABLED</span>}
        </span>
        <svg className="row-chevron" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </summary>

      <div className="row-body">
        {p.description && <p className="prow-desc">{p.description}</p>}
        <p className="prow-match lbl-line">
          <span className="lbl">Routing</span> {matchSummary(p)} · priority {p.priority}
        </p>
        {p.skills.length > 0 && (
          <p className="lbl-line"><span className="lbl">Skills</span> {p.skills.join(', ')}</p>
        )}
        {(p.allowedTools.length > 0 || p.disallowedTools.length > 0) && (
          <p className="lbl-line">
            <span className="lbl">Tools</span>
            {p.allowedTools.length > 0 && <> allow: {p.allowedTools.join(', ')}</>}
            {p.disallowedTools.length > 0 && <> · deny: {p.disallowedTools.join(', ')}</>}
          </p>
        )}
        {(p.fallbackModel || p.dailyBudgetMicros != null) && (
          <p className="lbl-line">
            <span className="lbl">Cost</span>
            {p.fallbackModel && <>fallback: {p.fallbackModel}</>}
            {p.dailyBudgetMicros != null && <>{p.fallbackModel ? ' · ' : ''}budget: ${(p.dailyBudgetMicros / 1_000_000).toFixed(2)}/day</>}
          </p>
        )}
        {(p.scheduleEnabled || autoPaused) && (
          <p className="lbl-line">
            <span className="lbl">Check-in</span> {scheduleSummary(p, projectSlug)}
            {' · '}
            {checkedInLabel}
            {/* "next" only once it has a baseline check-in — a never-run profile is due now, which "never run yet" already says. */}
            {p.scheduleEnabled && p.lastCheckInAt && nextRunAt && <> · next {formatShortDateTime(nextRunAt)}</>}
            {p.consecutiveFailures > 0 && (
              <span className="lbl-warn"> · ⚠ {p.consecutiveFailures} consecutive failure{p.consecutiveFailures === 1 ? '' : 's'}</span>
            )}
            {autoPaused && <span className="lbl-warn"> — auto-paused; edit to re-enable</span>}
          </p>
        )}
        {mcpNames.length > 0 && (
          <p className="lbl-line"><span className="lbl">MCP</span> {mcpNames.join(', ')}</p>
        )}
        {Object.keys(p.env).length > 0 && (
          <p className="lbl-line"><span className="lbl">Env</span> {Object.keys(p.env).join(', ')}</p>
        )}

        <div className="row-foot">
          <button type="button" className="btn btn-sm" onClick={onEdit} disabled={pending}>Edit</button>
          {!p.isDefault && (
            <button type="button" className="btn btn-sm" onClick={() => run(() => setDefaultProfile(p.id))} disabled={pending}>
              Set default
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => run(() => setProfileEnabled(p.id, !p.enabled))} disabled={pending}>
            {p.enabled ? 'Disable' : 'Enable'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={pending}
            onClick={() => {
              if (confirm(`Delete profile "${p.slug}"? Runs that used it keep their row.`)) run(() => deleteProfile(p.id));
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </details>
  );
}

export function ProfilesView({
  profiles,
  projectOptions,
  nextCheckIn,
}: {
  profiles: AgentProfile[];
  projectOptions: ProjectOption[];
  nextCheckIn: Record<string, string | null>;
}) {
  const [editing, setEditing] = useState<AgentProfile | 'new' | null>(null);
  const projectSlugById = new Map(projectOptions.map((o) => [o.id, o.slug]));

  return (
    <>
      <div className="prow-toolbar">
        <span className="prow-count lbl">{profiles.length} profile{profiles.length === 1 ? '' : 's'}</span>
        <button type="button" className="btn btn-accent" onClick={() => setEditing('new')}>+ New profile</button>
      </div>

      {profiles.length === 0 ? (
        <div className="prow-empty">
          No profiles yet. Create one to give auto-claimed agents task-specific skills, MCP servers, a model,
          and a tool policy — or an exec command for a non-Claude runtime.
        </div>
      ) : (
        <div className="ptable" role="table" aria-label="Agent profiles">
          <div className="col-head prow-head" role="row" aria-hidden="true">
            <span />
            <span>Profile</span>
            <span>Runtime</span>
            <span>Model</span>
            <span />
            <span />
          </div>
          <div className="ptable-body">
            {profiles.map((p) => (
              <ProfileRow
                key={p.id}
                p={p}
                projectSlug={p.scheduleProjectId ? (projectSlugById.get(p.scheduleProjectId) ?? null) : null}
                nextRunAt={nextCheckIn[p.id] ?? null}
                onEdit={() => setEditing(p)}
              />
            ))}
          </div>
        </div>
      )}

      {editing && (
        <ProfileModal
          profile={editing === 'new' ? undefined : editing}
          projectOptions={projectOptions}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

'use client';

// ABOUTME: Rich create/edit modal for an agent profile. Holds the whole ProfileFormState locally, renders the
// ABOUTME: structured sub-editors (chips, key/value rows, MCP-server cards, match-rule pickers), and on save
// ABOUTME: normalizes via lib/profile-form → calls the create/update server action. Validation/conflict errors
// ABOUTME: come back as { ok:false, error } and render inline. isDefault is NOT set here (row "Set default" owns it).

import { useState, useTransition } from 'react';
import { createProfile, updateProfile } from '@/app/actions';
import {
  emptyFormState,
  formStateFromProfile,
  formStateToInput,
  type ProfileFormState,
  type McpRow,
} from '@/lib/profile-form';
import { PERMISSION_MODES, type AgentProfile } from '@/lib/db/schema';
import { SCHEDULE_MIN_INTERVAL_SEC } from '@/lib/constants';
import { ChipInput, KeyValueRows, SegToggle } from './editors';

const MCP_TRANSPORTS = ['stdio', 'http', 'sse', 'ws'] as const;
const CATEGORY_OPTS = [
  ['internal', 'Internal'],
  ['open_source', 'Open source'],
  ['client', 'Client'],
] as const;

export type ProjectOption = { id: string; slug: string; name: string };

export function ProfileModal({
  profile,
  projectOptions,
  onClose,
}: {
  profile?: AgentProfile;
  projectOptions: ProjectOption[];
  onClose: () => void;
}) {
  const isEdit = !!profile;
  const [s, setS] = useState<ProfileFormState>(() => (profile ? formStateFromProfile(profile) : emptyFormState()));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const patch = (p: Partial<ProfileFormState>) => setS((cur) => ({ ...cur, ...p }));
  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const input = formStateToInput(s);
    startTransition(async () => {
      try {
        const res = isEdit ? await updateProfile(profile!.id, input) : await createProfile(input);
        if (res.ok) onClose();
        else setError(res.error);
      } catch {
        setError('Save failed.');
      }
    });
  }

  function setServer(i: number, p: Partial<McpRow>) {
    patch({ mcpServers: s.mcpServers.map((srv, j) => (j === i ? { ...srv, ...p } : srv)) });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>{isEdit ? `Edit profile · ${profile!.slug}` : 'New profile'}</h2>
        <form onSubmit={onSubmit}>
          {/* Identity */}
          <div className="field-row">
            <div className="field">
              <label>Slug</label>
              <input value={s.slug} onChange={(e) => patch({ slug: e.target.value })} placeholder="releaser" required autoFocus={!isEdit} />
            </div>
            <div className="field">
              <label>Name</label>
              <input value={s.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Release engineer" required />
            </div>
          </div>
          <div className="field">
            <label>Description</label>
            <input value={s.description} onChange={(e) => patch({ description: e.target.value })} />
          </div>

          {/* Runtime */}
          <div className="field-row">
            <SegToggle label="Runtime" value={s.runtime} options={['claude-code', 'exec'] as const} onChange={(runtime) => patch({ runtime })} />
            <div className="field">
              <label>Model</label>
              <input value={s.model} onChange={(e) => patch({ model: e.target.value })} placeholder="opus · gpt-4o · deepseek-v3" />
            </div>
          </div>

          {/* Cost-aware routing */}
          <div className="field-row">
            <div className="field">
              <label>Fallback model</label>
              <input value={s.fallbackModel} onChange={(e) => patch({ fallbackModel: e.target.value })} placeholder="claude-sonnet-4-6" />
            </div>
            <div className="field">
              <label>Daily budget (USD)</label>
              <input type="number" min="0" step="0.01" value={s.dailyBudgetUsd} onChange={(e) => patch({ dailyBudgetUsd: e.target.value })} placeholder="e.g. 5" />
            </div>
          </div>
          <p className="field-hint">
            Fallback model → claude&apos;s <code>--fallback-model</code> (overload resilience). With a daily budget, the daemon
            downgrades to it once this profile&apos;s same-day run cost exceeds the cap.
          </p>

          {s.runtime === 'claude-code' ? (
            <>
              <div className="field-row">
                <div className="field">
                  <label>Permission mode</label>
                  <select value={s.permissionMode} onChange={(e) => patch({ permissionMode: e.target.value })}>
                    <option value="">(daemon default)</option>
                    {PERMISSION_MODES.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Base URL (gateway)</label>
                  <input value={s.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} placeholder="optional" />
                </div>
              </div>
              <ChipInput label="Allowed tools" values={s.allowedTools} onChange={(v) => patch({ allowedTools: v })} placeholder="Bash, Edit" />
              <ChipInput label="Disallowed tools" values={s.disallowedTools} onChange={(v) => patch({ disallowedTools: v })} placeholder="WebFetch" />
            </>
          ) : (
            <div className="field">
              <label>Exec template</label>
              <textarea
                value={s.execTemplate}
                onChange={(e) => patch({ execTemplate: e.target.value })}
                rows={2}
                placeholder="litellm-run --model ${MODEL} --mcp ${MCP_CONFIG} --prompt ${PROMPT}"
              />
              <p className="field-hint">Tokens: <code>{'${MODEL}'}</code> <code>{'${PROMPT}'}</code> <code>{'${MCP_CONFIG}'}</code> — required for exec.</p>
            </div>
          )}

          {/* Persona + skills */}
          <div className="field">
            <label>Append system prompt (persona)</label>
            <textarea value={s.appendSystemPrompt} onChange={(e) => patch({ appendSystemPrompt: e.target.value })} rows={2} />
          </div>
          <ChipInput label="Skills (steered, not enforced)" values={s.skills} onChange={(v) => patch({ skills: v })} placeholder="deploy, canary" />

          {/* Env */}
          <KeyValueRows label="Environment (secrets as ${ENV} placeholders only)" rows={s.env} onChange={(env) => patch({ env })} />

          {/* MCP servers */}
          <div className="field">
            <label>MCP servers</label>
            <div className="mcp-cards">
              {s.mcpServers.map((srv, i) => (
                // cards are positional + freely renamed, so the array index is the stable identity here
                <div className="mcp-card" key={i}>
                  <div className="field-row">
                    <div className="field">
                      <label>Name</label>
                      <input value={srv.name} onChange={(e) => setServer(i, { name: e.target.value })} placeholder="github" />
                    </div>
                    <div className="field">
                      <label>Transport</label>
                      <select value={srv.type} onChange={(e) => setServer(i, { type: e.target.value as McpRow['type'] })}>
                        {MCP_TRANSPORTS.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </div>
                    <button type="button" className="btn btn-sm btn-bad mcp-remove" onClick={() => patch({ mcpServers: s.mcpServers.filter((_, j) => j !== i) })}>
                      Remove
                    </button>
                  </div>
                  {srv.type === 'stdio' ? (
                    <div className="field-row">
                      <div className="field">
                        <label>Command</label>
                        <input value={srv.command} onChange={(e) => setServer(i, { command: e.target.value })} placeholder="npx mcp-fs" />
                      </div>
                      <div className="field">
                        <label>Args (comma-separated)</label>
                        <input value={srv.args} onChange={(e) => setServer(i, { args: e.target.value })} placeholder="--root, /repo" />
                      </div>
                    </div>
                  ) : (
                    <div className="field">
                      <label>URL</label>
                      <input value={srv.url} onChange={(e) => setServer(i, { url: e.target.value })} placeholder="https://api.example.com/mcp/" />
                    </div>
                  )}
                  <KeyValueRows label="Env" rows={srv.env} onChange={(env) => setServer(i, { env })} />
                  <KeyValueRows label="Headers" rows={srv.headers} onChange={(headers) => setServer(i, { headers })} keyPlaceholder="Authorization" valuePlaceholder="Bearer ${TOKEN}" />
                </div>
              ))}
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => patch({ mcpServers: [...s.mcpServers, { name: '', type: 'stdio', command: '', args: '', url: '', env: [], headers: [] }] })}
              >
                + Add server
              </button>
            </div>
          </div>

          {/* Match rules */}
          <div className="field">
            <label>Match rules (auto-routing — all set dimensions are ANDed; empty = default-only)</label>
            <div className="match-block">
              {projectOptions.length > 0 && (
                <div className="match-line">
                  <span className="lbl">Projects</span>
                  <div className="toggle-row">
                    {projectOptions.map((p) => (
                      <button
                        key={p.slug}
                        type="button"
                        aria-pressed={s.matchProjectSlugs.includes(p.slug)}
                        className={`toggle-chip${s.matchProjectSlugs.includes(p.slug) ? ' on' : ''}`}
                        onClick={() => patch({ matchProjectSlugs: toggle(s.matchProjectSlugs, p.slug) })}
                        title={p.name}
                      >
                        {p.slug}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="match-line">
                <span className="lbl">Categories</span>
                <div className="toggle-row">
                  {CATEGORY_OPTS.map(([v, l]) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={s.matchProjectCategories.includes(v)}
                      className={`toggle-chip${s.matchProjectCategories.includes(v) ? ' on' : ''}`}
                      onClick={() => patch({ matchProjectCategories: toggle(s.matchProjectCategories, v) })}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label>Label pattern (regex)</label>
                <input value={s.matchLabelPattern} onChange={(e) => patch({ matchLabelPattern: e.target.value })} placeholder="^fix:" />
              </div>
            </div>
          </div>

          {/* Scheduled check-in */}
          <div className="field">
            <label>Scheduled check-in (wake this profile on its own schedule)</label>
            <div className="match-block">
              <label className="check-field">
                <input type="checkbox" checked={s.scheduleEnabled} onChange={(e) => patch({ scheduleEnabled: e.target.checked })} />
                Enable scheduled check-ins
              </label>
              {profile && profile.consecutiveFailures > 0 && (
                <p className="field-hint lbl-warn">
                  ⚠ {profile.consecutiveFailures} consecutive check-in failure{profile.consecutiveFailures === 1 ? '' : 's'}.
                  {!profile.scheduleEnabled && ' Auto-paused — re-enabling resumes check-ins (the counter resets on the next success).'}
                </p>
              )}
              {s.scheduleEnabled && (
                <>
                  <div className="field">
                    <label>Project (the check-in runs in its repo)</label>
                    <select value={s.scheduleProjectId} onChange={(e) => patch({ scheduleProjectId: e.target.value })}>
                      <option value="">(select a project)</option>
                      {projectOptions.map((p) => (
                        <option key={p.id} value={p.id}>{p.slug}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field-row">
                    <SegToggle label="Trigger" value={s.scheduleMode} options={['interval', 'cron'] as const} onChange={(scheduleMode) => patch({ scheduleMode })} />
                    {s.scheduleMode === 'interval' ? (
                      <div className="field">
                        <label>Interval (seconds)</label>
                        <input type="number" min={SCHEDULE_MIN_INTERVAL_SEC} value={s.scheduleIntervalSec} onChange={(e) => patch({ scheduleIntervalSec: e.target.value })} placeholder="1800" />
                      </div>
                    ) : (
                      <>
                        <div className="field">
                          <label>Cron expression</label>
                          <input value={s.scheduleCron} onChange={(e) => patch({ scheduleCron: e.target.value })} placeholder="0 9 * * 1-5" />
                        </div>
                        <div className="field">
                          <label>Timezone (optional)</label>
                          <input value={s.scheduleTimezone} onChange={(e) => patch({ scheduleTimezone: e.target.value })} placeholder="America/New_York" />
                          <p className="field-hint">IANA zone the cron fires in. Blank = the daemon&apos;s local time (may be UTC under launchd).</p>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="field">
                    <label>Check-in prompt (standing mission)</label>
                    <textarea value={s.checkInPrompt} onChange={(e) => patch({ checkInPrompt: e.target.value })} rows={2} placeholder="Triage new issues and pick up any queued work." />
                  </div>
                  <p className="field-hint">
                    To let the check-in claim queued tasks, grant the agent the mc tool — add <code>Bash(mc:*)</code> to Allowed
                    tools (or set permission mode <code>bypassPermissions</code>). A headless run denies Bash by default.
                  </p>
                </>
              )}
            </div>
          </div>

          {/* Routing */}
          <div className="field-row">
            <div className="field">
              <label>Priority (higher wins ties)</label>
              <input type="number" value={s.priority} onChange={(e) => patch({ priority: e.target.value })} />
            </div>
            <label className="check-field">
              <input type="checkbox" checked={s.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
              Enabled
            </label>
          </div>

          {error && <p className="modal-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-accent" disabled={pending}>
              {pending ? 'Saving…' : isEdit ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

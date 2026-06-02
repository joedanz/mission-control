'use client';

// ABOUTME: Mission tab surface — a live Runs strip + the activity event feed, polling /api/activity.
// ABOUTME: Phase 3 grows this into the full 3-pane board; the data seam (useActivityFeed) stays.

import { formatCost, runTone } from '@/lib/ui';
import { useActivityFeed } from '@/lib/useActivityFeed';
import { EventList } from '@/components/EventList';

export function ActivityFeed({ projectId, showRuns = true }: { projectId?: string; showRuns?: boolean }) {
  const { events, runs, loaded, error } = useActivityFeed({ projectId });

  return (
    <div className="mc">
      {showRuns && (
        <section className="mc-runs" aria-label="Agent runs">
          <h2 className="section-sublabel">
            Fleet <span className="mc-count">{runs.filter((r) => r.live).length} live</span>
          </h2>
          {runs.length === 0 ? (
            <p className="mc-empty">{loaded ? 'No runs yet.' : 'Loading…'}</p>
          ) : (
            <div className="mc-run-list">
              {runs.map((r) => (
                <a className="mc-run" data-tone={runTone(r)} key={r.id} href={`/runs/${r.id}`}>
                  <span className={`sig-dot${r.live ? ' pulse-dot' : ''}`} aria-hidden="true" />
                  <span className="mc-run-agent">{r.agentLabel}</span>
                  <span className="mc-run-status">{r.live ? 'live' : r.status}</span>
                  <span className="mc-run-meta">
                    {[
                      r.claimedTask ? `▸ ${r.claimedTask.label}` : null,
                      formatCost(r.costMicros) || null,
                      r.tokensIn + r.tokensOut > 0 ? `${r.tokensIn + r.tokensOut} tok` : null,
                    ]
                      .filter(Boolean)
                      .join('  ·  ')}
                  </span>
                </a>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="mc-feed-wrap" aria-label="Activity">
        <h2 className="section-sublabel">Activity {error ? <span className="mc-err">· {error}</span> : null}</h2>
        {events.length === 0 ? (
          <p className="mc-empty">{loaded ? 'No activity yet.' : 'Loading…'}</p>
        ) : (
          <EventList events={events} />
        )}
      </section>
    </div>
  );
}

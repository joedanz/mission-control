'use client';

// ABOUTME: The live "Fleet" runs strip — agent label, live dot, status, claimed task, cost/tokens.
// ABOUTME: Extracted from ActivityFeed so the Mission tab AND the boards render one identical strip.
// ABOUTME: Self-wraps in `.mc` so the `.mc .sig-dot/.pulse-dot` scoped styles apply wherever it mounts.

import { formatCost, runTone } from '@/lib/ui';
import type { FeedRun } from '@/lib/useActivityFeed';

export function FleetRail({ runs, loaded }: { runs: FeedRun[]; loaded: boolean }) {
  return (
    <div className="mc">
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
    </div>
  );
}

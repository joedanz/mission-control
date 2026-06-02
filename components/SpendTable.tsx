// ABOUTME: Spend rollup view (Server Component) — a KPI strip, a group-by switch, and a bucketed cost
// ABOUTME: table. Pure presentation over a SpendRollup; all aggregation is done DB-side in getSpendRollup.

import Link from 'next/link';
import type { SpendRollup, SpendGroupBy } from '@/lib/queries';
import { formatDollars, formatTokens } from '@/lib/ui';

const GROUPS: { key: SpendGroupBy; label: string }[] = [
  { key: 'project', label: 'Project' },
  { key: 'agent', label: 'Agent' },
  { key: 'day', label: 'Day' },
  { key: 'run', label: 'Run' },
];

export function SpendTable({ rollup }: { rollup: SpendRollup }) {
  const { rows, totals, groupBy, truncated } = rollup;
  const totalTokens = totals.tokensIn + totals.tokensOut + totals.cacheReadTokens + totals.cacheWriteTokens;
  const avgPerRun = totals.runCount > 0 ? Math.round(totals.costMicros / totals.runCount) : 0;
  const top = rows[0];
  const noun = groupBy; // the axis key reads as its own noun ("project"/"agent"/"day"/"run")
  const activeLabel = GROUPS.find((g) => g.key === groupBy)?.label ?? groupBy;

  const kpis = [
    { tone: 'ok' as const, cap: 'Total Spend', num: formatDollars(totals.costMicros), foot: rollup.since || rollup.until ? 'windowed' : 'all runs' },
    { tone: 'neutral' as const, cap: 'Runs', num: formatTokens(totals.runCount), foot: 'priced' },
    { tone: 'info' as const, cap: 'Tokens', num: formatTokens(totalTokens), foot: 'in · out · cache' },
    { tone: 'violet' as const, cap: 'Avg / Run', num: formatDollars(avgPerRun), foot: 'per run' },
    { tone: 'warn' as const, cap: `Top ${noun}`, num: top ? formatDollars(top.costMicros) : '$0.00', foot: top ? top.label : '—' },
  ];

  return (
    <>
      <div className="statstrip" role="group" aria-label="Spend metrics">
        {kpis.map((k) => (
          <div className="stat" data-tone={k.tone} key={k.cap}>
            <div className="stat-top">
              <span className="sig-dot" aria-hidden="true" />
              <span className="stat-cap">{k.cap}</span>
            </div>
            <span className="stat-num">{k.num}</span>
            <div className="stat-foot" title={k.foot}>{k.foot}</div>
          </div>
        ))}
      </div>

      <nav className="spend-switch" aria-label="Group spend by">
        {GROUPS.map((g) => {
          const active = g.key === groupBy;
          return (
            <Link
              key={g.key}
              href={`/spend?by=${g.key}`}
              aria-current={active ? 'page' : undefined}
              className={`pill${active ? ' ok' : ''}`}
            >
              {g.label}
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-title">No spend recorded yet</p>
          <p className="empty-state-hint">Runs priced after the next agent session will appear here.</p>
        </div>
      ) : (
        <div className="spend-table" role="table" aria-label={`Spend by ${noun}`}>
          <div className="spend-head" role="row">
            <span role="columnheader">{activeLabel}</span>
            <span className="spend-r" role="columnheader">Spend</span>
            <span role="columnheader">Share</span>
            <span className="spend-r" role="columnheader">Runs</span>
            <span className="spend-r" role="columnheader">Tokens</span>
          </div>
          <div className="spend-body">
            {rows.map((r) => {
              const tok = r.tokensIn + r.tokensOut + r.cacheReadTokens + r.cacheWriteTokens;
              const share = totals.costMicros > 0 ? (r.costMicros / totals.costMicros) * 100 : 0;
              return (
                <div className="spend-row" role="row" key={r.key}>
                  <span className="spend-label" role="cell" title={r.label}>{r.label}</span>
                  <span className="spend-r spend-cost" role="cell">{formatDollars(r.costMicros)}</span>
                  <span className="spend-share" role="cell">
                    <span className="spend-bar" aria-hidden="true">
                      <span style={{ width: `${share.toFixed(1)}%` }} />
                    </span>
                    <span className="spend-pct">{share.toFixed(0)}%</span>
                  </span>
                  <span className="spend-r" role="cell">{formatTokens(r.runCount)}</span>
                  <span className="spend-r" role="cell">{formatTokens(tok)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {truncated && (
        <p className="spend-note">
          {groupBy === 'day'
            ? `Showing the ${rows.length} most recent days.`
            : `Showing the top ${rows.length} ${noun} buckets by spend.`}
        </p>
      )}
    </>
  );
}

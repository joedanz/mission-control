// ABOUTME: Integration matrix (Server Component) — a collapsible Sentry/Zoho coverage grid with a
// ABOUTME: progress meter. Extracted from the old dashboard so the Overview section can reuse it.

import type { IntegrationGrid } from '@/lib/queries';

// Compact instrument codes — the "Mission Control" readout voice (uppercased again in CSS).
const STATE_LABEL: Record<string, string> = { done: 'OK', needed: 'Need', pending: 'Pend' };

export function Matrix({
  title,
  grid,
  note,
  open,
}: {
  title: string;
  grid: IntegrationGrid;
  note?: string | null;
  open?: boolean;
}) {
  const pct = grid.total > 0 ? Math.round((grid.done / grid.total) * 100) : 0;
  return (
    <details className="matrix" open={open}>
      <summary>
        <span className="matrix-title">{title}</span>
        <span className="matrix-meter">
          <span className="meter-track" aria-hidden="true">
            <span className="meter-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="meter-num">{grid.done} / {grid.total}</span>
        </span>
      </summary>
      <div className="matrix-grid">
        {grid.rows.map((r) => (
          <div className="matrix-cell" key={r.projectId}>
            <span className="label">{r.label}</span>
            <span className={`state ${r.status}`}>{STATE_LABEL[r.status] ?? r.status}</span>
          </div>
        ))}
      </div>
      {note && <div className="matrix-note">{note}</div>}
    </details>
  );
}

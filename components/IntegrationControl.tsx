'use client';

// ABOUTME: Tri-state integration status control (needed/pending/done) for the detail page.
// ABOUTME: Optimistic via useTransition; reuses the existing setIntegrationStatus server action.

import { useState, useTransition } from 'react';
import { setIntegrationStatus } from '@/app/actions';
import { INTEGRATION_STATUSES, type IntegrationStatus } from '@/lib/db/schema';

export function IntegrationControl({
  taskId,
  label,
  status,
}: {
  taskId: string;
  label: string;
  status: IntegrationStatus;
}) {
  const [optimistic, setOptimistic] = useState<IntegrationStatus>(status);
  const [, startTransition] = useTransition();

  function set(s: IntegrationStatus) {
    setOptimistic(s);
    startTransition(() => {
      void setIntegrationStatus(taskId, s);
    });
  }

  return (
    <div className="intg-control">
      <span className="intg-control-label">{label}</span>
      <div className="seg" role="group" aria-label={`${label} status`}>
        {INTEGRATION_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={`seg-btn ${s}${optimistic === s ? ' on' : ''}`}
            aria-pressed={optimistic === s}
            onClick={() => set(s)}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

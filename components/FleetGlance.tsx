'use client';

// ABOUTME: Overview's live "Fleet" glance — the same FleetRail strip the Mission tab renders,
// ABOUTME: capped to a handful of runs, with a link out to the full /mission view.

import { useActivityFeed } from '@/lib/useActivityFeed';
import { FleetRail } from '@/components/FleetRail';

// Matches the Overview's Recently Active slice(0, 6) so the two sections feel balanced.
const GLANCE_LIMIT = 6;

export function FleetGlance() {
  const { runs, loaded } = useActivityFeed();
  return (
    <>
      <FleetRail runs={runs.slice(0, GLANCE_LIMIT)} loaded={loaded} />
      <a className="section-action" href="/mission">
        View all in Mission →
      </a>
    </>
  );
}

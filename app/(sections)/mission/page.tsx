// ABOUTME: Mission Control (Phase 1) — the live activity feed + runs strip. Auth-gated, always dynamic.
// ABOUTME: Phase 3 grows this into the full dense 3-pane board (fleet · stream · stats) over SSE.

import { redirect } from 'next/navigation';
import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { ActivityFeed } from '@/components/ActivityFeed';

export const dynamic = 'force-dynamic';

export default async function MissionPage() {
  try {
    await requireAllowedUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect('/login');
    throw e;
  }

  return (
    <>
      <div className="section-head">
        <h1 className="section-title">Mission Control</h1>
      </div>
      <ActivityFeed />
    </>
  );
}

// ABOUTME: Profiles section — the human operator's view of agent profiles (the capability bundles the
// ABOUTME: daemon renders into each spawn). Auth-gated, always dynamic. Fetches all profiles + a lightweight
// ABOUTME: project list (for the match-rule pickers) and hands them to the client ProfilesView.

import { redirect } from 'next/navigation';
import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getProfiles, getSearchIndex } from '@/lib/queries';
import { nextCheckInAt } from '@/daemon/schedule';
import { ProfilesView } from '@/components/profiles/ProfilesView';

export const dynamic = 'force-dynamic';

export default async function ProfilesPage() {
  try {
    await requireAllowedUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect('/login');
    throw e;
  }

  const [profiles, projects] = await Promise.all([getProfiles(), getSearchIndex()]);
  const projectOptions = projects.map((p) => ({ id: p.id, slug: p.slug, name: p.name }));
  // Next scheduled fire per enabled-schedule profile (croner lives server-side; ISO over the wire). The row
  // renders it; relative "last check-in" is computed client-side so it stays live without a refetch.
  const now = new Date();
  const nextCheckIn: Record<string, string | null> = {};
  for (const p of profiles) {
    if (p.scheduleEnabled) nextCheckIn[p.id] = nextCheckInAt(p, now)?.toISOString() ?? null;
  }

  return (
    <>
      <div className="section-head">
        <h1 className="section-title">Profiles</h1>
        <p className="section-sublabel">
          Capability bundles + auto-routing rules. The auto-claim daemon resolves the matching profile for
          each task and renders it into the spawn (claude-code flags or an exec command).
        </p>
      </div>
      <ProfilesView profiles={profiles} projectOptions={projectOptions} nextCheckIn={nextCheckIn} />
    </>
  );
}

// ABOUTME: Run drill-in page (Server Component). Auth-gated, dynamic; renders the global chrome then
// ABOUTME: the client RunDetail, which polls /api/runs/[id] for live updates (one data path).

import { redirect } from 'next/navigation';
import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getSearchIndex } from '@/lib/queries';
import { TopBar } from '@/components/chrome/TopBar';
import { RunDetail } from '@/components/RunDetail';

export const dynamic = 'force-dynamic';

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  let email = '';
  try {
    const session = await requireAllowedUser();
    email = session.user.email;
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect('/login');
    throw e;
  }

  const { id } = await params;
  const index = await getSearchIndex();

  return (
    <>
      <TopBar index={index} email={email} />
      <main className="content-shell">
        {/* key by id so navigating run→run remounts with clean state (no stale-data flash) */}
        <RunDetail key={id} id={id} />
      </main>
    </>
  );
}

// ABOUTME: Spend section (Server Component) — cost rolled up over runs by project/agent/day/run.
// ABOUTME: Auth-gated, always dynamic; the group-by axis comes from ?by= (defaults to project).

import { redirect } from 'next/navigation';
import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getSpendRollup } from '@/lib/queries';
import { SPEND_GROUP_BYS, type SpendGroupBy } from '@/lib/constants';
import { SpendTable } from '@/components/SpendTable';

export const dynamic = 'force-dynamic';

export default async function SpendPage({ searchParams }: { searchParams: Promise<{ by?: string }> }) {
  try {
    await requireAllowedUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect('/login');
    throw e;
  }

  const { by } = await searchParams;
  const groupBy: SpendGroupBy = SPEND_GROUP_BYS.includes(by as SpendGroupBy) ? (by as SpendGroupBy) : 'project';
  const rollup = await getSpendRollup({ groupBy, limit: 100 });

  return (
    <>
      <div className="section-head">
        <h1 className="section-title">Spend</h1>
      </div>
      <SpendTable rollup={rollup} />
    </>
  );
}

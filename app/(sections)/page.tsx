// ABOUTME: Overview section (Server Component) — the summary landing: stat strip, integration
// ABOUTME: health (Sentry/Zoho matrices), and a recently-active list. Auth-gated, always dynamic.

import { redirect } from 'next/navigation';
import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getDashboard } from '@/lib/queries';
import { Matrix } from '@/components/Matrix';
import { RecentActivity } from '@/components/RecentActivity';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  try {
    await requireAllowedUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect('/login');
    throw e;
  }

  const { all, stats, sentry, zoho, aliasesNote } = await getDashboard();
  const recent = [...all]
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
    .slice(0, 6);

  const metrics = [
    { tone: 'neutral', label: 'Total', value: stats.total, foot: 'all projects' },
    { tone: 'warn', label: 'Pre-launch', value: stats.prelaunch, foot: 'in progress' },
    { tone: 'ok', label: 'Launched', value: stats.launched, foot: 'live · ok' },
    { tone: 'info', label: 'Client', value: stats.client, foot: 'external' },
    { tone: 'violet', label: 'Open Source', value: stats.openSource, foot: 'public' },
  ] as const;

  return (
    <>
      <div className="section-head">
        <h1 className="section-title">Overview</h1>
      </div>

      <div className="statstrip" role="group" aria-label="Portfolio metrics">
        {metrics.map((m) => (
          <div className="stat" data-tone={m.tone} key={m.label}>
            <div className="stat-top">
              <span className="sig-dot" aria-hidden="true" />
              <span className="stat-cap">{m.label}</span>
            </div>
            <span className="stat-num">{m.value}</span>
            <div className="stat-foot">{m.foot}</div>
          </div>
        ))}
      </div>

      <h2 className="section-sublabel">Integration Status Board</h2>
      <div className="matrices">
        <Matrix title="Sentry — Error Tracking" grid={sentry} open />
        <Matrix title="Zoho — Email Setup" grid={zoho} note={aliasesNote} open />
      </div>

      <h2 className="section-sublabel">Recently Active</h2>
      <RecentActivity projects={recent} />
    </>
  );
}

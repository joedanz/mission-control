// ABOUTME: Shared chrome for the root sections (Overview + Projects). Renders the global top bar
// ABOUTME: and the section tab strip once, then the page in a wide centered content shell.
// ABOUTME: Gated here AND in each page (defense in depth); fetches the search index for the chrome.

import { redirect } from 'next/navigation';
import { requireAllowedUser, UnauthorizedError } from '@/lib/authz';
import { getSearchIndex } from '@/lib/queries';
import { TopBar } from '@/components/chrome/TopBar';
import { PrimaryTabs } from '@/components/chrome/PrimaryTabs';

export const dynamic = 'force-dynamic';

export default async function SectionsLayout({ children }: { children: React.ReactNode }) {
  let email = '';
  try {
    const session = await requireAllowedUser();
    email = session.user.email;
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect('/login');
    throw e;
  }

  const index = await getSearchIndex();

  return (
    <>
      <TopBar index={index} email={email} />
      <div className="chrome-tabs">
        <div className="chrome-tabs-inner">
          <PrimaryTabs />
        </div>
      </div>
      <main className="content-shell">{children}</main>
      <footer className="footer-bar">
        <div className="footer-bar-inner">
          <span className="footer-text">Mission Control · managed with agents</span>
          <span className="footer-badge">v2</span>
        </div>
      </footer>
    </>
  );
}

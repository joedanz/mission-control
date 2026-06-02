// ABOUTME: Root layout — loads the type system (Inter Tight UI + IBM Plex Mono data/labels) and
// ABOUTME: the M3 "Mission Control" theme. A pre-paint script resolves light/dark before hydration
// ABOUTME: (localStorage → prefers-color-scheme) so there is no flash of the wrong theme.

import type { Metadata } from 'next';
import { Inter_Tight, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

const interTight = Inter_Tight({
  variable: '--font-inter',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
});

const plexMono = IBM_Plex_Mono({
  variable: '--font-plex',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'Mission Control',
  description: 'Operator console for your projects',
};

// Runs before first paint: pick the theme from a saved preference, else the OS setting.
// Setting data-theme on <html> here (not in React) is why <html> needs suppressHydrationWarning.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('mc-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='light';}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${interTight.variable} ${plexMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

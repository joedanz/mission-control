'use client';

// ABOUTME: Instrument-header system readout — a live UTC clock + a pulsing LIVE dot. Decorative
// ABOUTME: (aria-hidden); the M3 "Mission Control" signature. Renders a static placeholder on the
// ABOUTME: server and starts ticking on mount, so there is no hydration mismatch. Hidden < 1024px.

import { useEffect, useState } from 'react';

function utcNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function SysReadout() {
  const [clock, setClock] = useState('--:--:--');

  useEffect(() => {
    const update = () => setClock(utcNow());
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // First value via rAF (not a synchronous setState in the effect body); then tick each second.
    const raf = requestAnimationFrame(update);
    const id = reduce ? null : setInterval(update, 1000);
    return () => {
      cancelAnimationFrame(raf);
      if (id) clearInterval(id);
    };
  }, []);

  return (
    <div className="sys-readout" aria-hidden="true">
      <span className="seg">
        <span className="pulse-dot" />
        <span className="lbl">live</span>
      </span>
      <span className="seg">
        <span className="lbl">utc</span>
        <span className="val">{clock}</span>
      </span>
    </div>
  );
}

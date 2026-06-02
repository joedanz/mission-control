// ABOUTME: Generic email-DNS verification — MX/SPF/DMARC lookups + provider inference from MX.
// ABOUTME: Uses node:dns/promises (no auth). ENOTFOUND/ENODATA → "not present"; other errors propagate.

import { resolveMx, resolveTxt } from 'node:dns/promises';

export type EmailDnsResult = {
  mx: { present: boolean; records: string[] };
  spf: { present: boolean; record: string | null };
  dmarc: { present: boolean; record: string | null };
  detectedProvider: string | null;
};

// MX-host substring → friendly provider name. First match wins.
const PROVIDER_MATCHERS: { needle: string; name: string }[] = [
  { needle: 'zoho.', name: 'Zoho Mail' },
  { needle: 'aspmx.l.google.com', name: 'Google Workspace' },
  { needle: 'googlemail.com', name: 'Google Workspace' },
  { needle: 'protection.outlook.com', name: 'Microsoft 365' },
  { needle: 'outlook.com', name: 'Microsoft 365' },
  { needle: 'proton.me', name: 'Proton Mail' },
  { needle: 'protonmail.', name: 'Proton Mail' },
  { needle: 'messagingengine.com', name: 'Fastmail' },
  { needle: 'icloud.com', name: 'iCloud' },
  { needle: 'mail.me.com', name: 'iCloud' },
];

export function detectProvider(mxHosts: string[]): string | null {
  for (const host of mxHosts) {
    const h = host.toLowerCase().replace(/\.$/, '');
    for (const m of PROVIDER_MATCHERS) {
      if (h.includes(m.needle)) return m.name;
    }
  }
  return null;
}

const NOT_PRESENT_CODES = new Set(['ENOTFOUND', 'ENODATA']);
function isNotPresent(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e
    && NOT_PRESENT_CODES.has((e as { code: string }).code);
}

async function safeMx(domain: string): Promise<string[]> {
  try {
    const recs = await resolveMx(domain);
    return [...recs].sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
  } catch (e) {
    if (isNotPresent(e)) return [];
    throw e;
  }
}

async function safeTxt(name: string): Promise<string[]> {
  try {
    const recs = await resolveTxt(name);
    return recs.map((chunks) => chunks.join(''));
  } catch (e) {
    if (isNotPresent(e)) return [];
    throw e;
  }
}

export async function checkEmailDns(domain: string): Promise<EmailDnsResult> {
  const [mxHosts, txt, dmarcTxt] = await Promise.all([
    safeMx(domain),
    safeTxt(domain),
    safeTxt(`_dmarc.${domain}`),
  ]);
  const spf = txt.find((r) => r.toLowerCase().startsWith('v=spf1')) ?? null;
  const dmarc = dmarcTxt.find((r) => r.toLowerCase().startsWith('v=dmarc1')) ?? null;
  return {
    mx: { present: mxHosts.length > 0, records: mxHosts },
    spf: { present: spf !== null, record: spf },
    dmarc: { present: dmarc !== null, record: dmarc },
    detectedProvider: detectProvider(mxHosts),
  };
}

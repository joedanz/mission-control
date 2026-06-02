// ABOUTME: Unit tests for lib/email-dns — mocks node:dns/promises; no network.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:dns/promises', () => ({ resolveMx: vi.fn(), resolveTxt: vi.fn() }));
import { resolveMx, resolveTxt } from 'node:dns/promises';
import { checkEmailDns, detectProvider } from '../lib/email-dns';

const mx = vi.mocked(resolveMx);
const txt = vi.mocked(resolveTxt);

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

beforeEach(() => { mx.mockReset(); txt.mockReset(); });

describe('detectProvider', () => {
  it('maps known MX suffixes', () => {
    expect(detectProvider(['aspmx.l.google.com'])).toBe('Google Workspace');
    expect(detectProvider(['mx.zoho.com'])).toBe('Zoho Mail');
    expect(detectProvider(['acme-com.mail.protection.outlook.com'])).toBe('Microsoft 365');
    expect(detectProvider(['mail.example.net'])).toBeNull();
  });
});

describe('checkEmailDns', () => {
  it('parses MX (priority-sorted), SPF, DMARC, and detects provider', async () => {
    mx.mockResolvedValue([
      { priority: 20, exchange: 'alt1.aspmx.l.google.com' },
      { priority: 10, exchange: 'aspmx.l.google.com' },
    ]);
    txt.mockImplementation((name: string) =>
      name.startsWith('_dmarc.')
        ? Promise.resolve([['v=DMARC1; p=none']])
        : Promise.resolve([['some=other'], ['v=spf1 include:_spf.google.com ~all']]),
    );

    const r = await checkEmailDns('example.com');
    expect(r.mx).toEqual({ present: true, records: ['aspmx.l.google.com', 'alt1.aspmx.l.google.com'] });
    expect(r.spf).toEqual({ present: true, record: 'v=spf1 include:_spf.google.com ~all' });
    expect(r.dmarc).toEqual({ present: true, record: 'v=DMARC1; p=none' });
    expect(r.detectedProvider).toBe('Google Workspace');
  });

  it('treats ENOTFOUND/ENODATA as not-present (no throw)', async () => {
    mx.mockRejectedValue(dnsError('ENOTFOUND'));
    txt.mockRejectedValue(dnsError('ENODATA'));
    const r = await checkEmailDns('nope.example');
    expect(r.mx.present).toBe(false);
    expect(r.spf.present).toBe(false);
    expect(r.dmarc.present).toBe(false);
    expect(r.detectedProvider).toBeNull();
  });

  it('propagates unexpected resolver errors', async () => {
    mx.mockRejectedValue(dnsError('ESERVFAIL'));
    txt.mockResolvedValue([]);
    await expect(checkEmailDns('flaky.example')).rejects.toMatchObject({ code: 'ESERVFAIL' });
  });
});

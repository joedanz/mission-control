// ABOUTME: skills.sh registry client (lib/skills-registry.ts) — pure id parsing + fetch-mocked search.
// ABOUTME: No network: global fetch is stubbed per case. Pins the UNAUTHENTICATED /api/search contract.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { searchSkills, parseRegistryId, SkillsRegistryError, type RegistrySkill } from '../lib/skills-registry';
import { ValidationError } from '../lib/validation';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const SAMPLE = {
  query: 'react',
  searchType: 'fuzzy',
  skills: [
    { id: 'vercel-labs/agent-skills/vercel-react-best-practices', skillId: 'vercel-react-best-practices', name: 'vercel-react-best-practices', installs: 456878, source: 'vercel-labs/agent-skills' },
    { id: 'expo/skills/react-native', skillId: 'react-native', name: 'React Native', installs: 3842, source: 'expo/skills' },
  ],
  count: 2,
};

describe('parseRegistryId', () => {
  it('splits owner/repo/slug into source + slug', () => {
    expect(parseRegistryId('vercel-labs/skills/find-skills')).toEqual({ source: 'vercel-labs/skills', slug: 'find-skills' });
  });
  it('returns null for an id without at least owner/repo/slug', () => {
    expect(parseRegistryId('owner/repo')).toBeNull();
    expect(parseRegistryId('justone')).toBeNull();
    expect(parseRegistryId('')).toBeNull();
  });
});

describe('searchSkills (mocked fetch)', () => {
  it('maps the /api/search envelope to RegistrySkill[], sorted by installs desc', async () => {
    mockFetch(200, SAMPLE);
    const items = await searchSkills({ q: 'react' });
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual<RegistrySkill>({
      id: 'vercel-labs/agent-skills/vercel-react-best-practices',
      slug: 'vercel-react-best-practices',
      name: 'vercel-react-best-practices',
      source: 'vercel-labs/agent-skills',
      installs: 456878,
    });
    expect(items[1].slug).toBe('react-native');
  });

  it('hits the unauthenticated /api/search endpoint with q + limit and NO auth header', async () => {
    const fn = mockFetch(200, { skills: [] });
    await searchSkills({ q: 'react native', limit: 5 });
    const url = String(fn.mock.calls[0][0]);
    expect(url).toContain('/api/search');
    expect(url).toContain('q=react+native');
    expect(url).toContain('limit=5');
    // No second arg (no headers/init) — the endpoint is public.
    expect(fn.mock.calls[0][1]).toBeUndefined();
  });

  it('respects SKILLS_API_URL override', async () => {
    vi.stubEnv('SKILLS_API_URL', 'https://staging.example.com');
    const fn = mockFetch(200, { skills: [] });
    await searchSkills({ q: 'react' });
    expect(String(fn.mock.calls[0][0]).startsWith('https://staging.example.com/api/search')).toBe(true);
  });

  it('derives slug/source from id when explicit fields are absent', async () => {
    mockFetch(200, { skills: [{ id: 'a/b/c-skill' }] });
    const items = await searchSkills({ q: 'xy' });
    expect(items[0]).toMatchObject({ id: 'a/b/c-skill', slug: 'c-skill', source: 'a/b', name: 'c-skill', installs: 0 });
  });

  it('drops malformed rows (no usable id)', async () => {
    mockFetch(200, { skills: [{ name: 'orphan' }, SAMPLE.skills[0]] });
    const items = await searchSkills({ q: 'react' });
    expect(items).toHaveLength(1);
    expect(items[0].slug).toBe('vercel-react-best-practices');
  });

  it('rejects a query shorter than 2 chars with ValidationError (before any fetch)', async () => {
    const fn = mockFetch(200, SAMPLE);
    await expect(searchSkills({ q: 'a' })).rejects.toBeInstanceOf(ValidationError);
    await expect(searchSkills({ q: '  ' })).rejects.toBeInstanceOf(ValidationError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('throws SkillsRegistryError carrying the status on a non-2xx response', async () => {
    mockFetch(503, { error: 'service_unavailable' });
    const err = await searchSkills({ q: 'react' }).catch((e) => e);
    expect(err).toBeInstanceOf(SkillsRegistryError);
    expect(err.status).toBe(503);
  });

  it('wraps a network failure in SkillsRegistryError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(searchSkills({ q: 'react' })).rejects.toBeInstanceOf(SkillsRegistryError);
  });
});

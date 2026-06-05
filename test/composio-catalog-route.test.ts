// ABOUTME: Tests the MCP catalog browse endpoint — GET lists Composio's live catalog with featured +
// ABOUTME: connected flags. CI-safe: mocks the auth gate, listToolkits, and listConnections.
import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeUnauthorized extends Error {}
const requireAllowedUser = vi.fn(async () => ({ user: { email: 'joe@ticc.net' } }));
vi.mock('@/lib/authz', () => ({ requireAllowedUser: () => requireAllowedUser(), UnauthorizedError: FakeUnauthorized }));

const listToolkits = vi.fn();
vi.mock('@/lib/composio-api', () => ({ listToolkits: (o?: unknown) => listToolkits(o), ComposioApiError: class extends Error {} }));
const listConnections = vi.fn();
vi.mock('@/lib/composio-connections', () => ({ listConnections: (s: string) => listConnections(s) }));

const { GET } = await import('../app/api/projects/[slug]/composio/catalog/route');
const params = Promise.resolve({ slug: 'demo' });
function get(qs = '') { return GET(new Request(`http://localhost/api/projects/demo/composio/catalog${qs}`), { params }); }

beforeEach(() => {
  vi.clearAllMocks();
  requireAllowedUser.mockResolvedValue({ user: { email: 'joe@ticc.net' } });
  listConnections.mockResolvedValue([]);
});

describe('GET catalog', () => {
  it('returns toolkits with featured + connected flags', async () => {
    listToolkits.mockResolvedValue([
      { slug: 'linear', name: 'Linear', description: '', toolCount: 4, categories: [] },
      { slug: 'notion', name: 'Notion', description: '', toolCount: 9, categories: [] },
    ]);
    listConnections.mockResolvedValue([{ source: 'composio', toolkitSlug: 'linear', status: 'active' }]);
    const res = await get('?search=l');
    expect(res.status).toBe(200);
    const json = await res.json();
    const linear = json.data.toolkits.find((t: { slug: string }) => t.slug === 'linear');
    const notion = json.data.toolkits.find((t: { slug: string }) => t.slug === 'notion');
    expect(linear.featured).toBe(true);
    expect(linear.connected).toBe(true);
    expect(notion.featured).toBe(false);
    expect(notion.connected).toBe(false);
    expect(listToolkits).toHaveBeenCalledWith({ search: 'l', limit: undefined });
  });

  it('passes a numeric limit through; ignores a non-numeric one', async () => {
    listToolkits.mockResolvedValue([]);
    await get('?limit=20');
    expect(listToolkits).toHaveBeenCalledWith({ search: undefined, limit: 20 });
    await get('?limit=abc');
    expect(listToolkits).toHaveBeenLastCalledWith({ search: undefined, limit: undefined });
  });

  it('401 when the auth gate rejects', async () => {
    requireAllowedUser.mockRejectedValue(new FakeUnauthorized());
    expect((await get()).status).toBe(401);
  });
});

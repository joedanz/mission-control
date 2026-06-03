// ABOUTME: Tests for the project Composio route — GET merges catalog+connections; POST dispatches
// ABOUTME: connect/status/disconnect and maps NotFound/Validation/ComposioApi/Unauthorized to status codes.
// ABOUTME: CI-safe: mocks the auth gate + the lifecycle lib (no DB, no Composio network).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError, ValidationError } from '../lib/validation';
import { ComposioApiError } from '../lib/composio-api';

class FakeUnauthorized extends Error {}

const requireAllowedUser = vi.fn(async () => ({ user: { email: 'joe@ticc.net' } }));
vi.mock('@/lib/authz', () => ({
  requireAllowedUser: () => requireAllowedUser(),
  UnauthorizedError: FakeUnauthorized,
}));

const lib = {
  listConnections: vi.fn(),
  connectStart: vi.fn(),
  connectPoll: vi.fn(),
  disconnect: vi.fn(),
};
vi.mock('@/lib/composio-connections', () => lib);

// Import AFTER mocks are registered.
const { GET, POST } = await import('../app/api/projects/[slug]/composio/route');

const params = Promise.resolve({ slug: 'demo' });
function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/projects/demo/composio', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAllowedUser.mockResolvedValue({ user: { email: 'joe@ticc.net' } });
});

describe('GET', () => {
  it('returns merged toolkit views', async () => {
    lib.listConnections.mockResolvedValue([
      { toolkitSlug: 'linear', status: 'active', linkUrl: null, error: null },
    ]);
    const res = await GET(new Request('http://localhost/api/projects/demo/composio'), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    const linear = json.data.toolkits.find((t: { slug: string }) => t.slug === 'linear');
    expect(linear.status).toBe('active');
    expect(linear.toolCount).toBe(4);
  });

  it('401 when the auth gate rejects', async () => {
    requireAllowedUser.mockRejectedValue(new FakeUnauthorized());
    const res = await GET(new Request('http://localhost/api/projects/demo/composio'), { params });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
  });
});

describe('POST dispatch', () => {
  it('connect → returns linkUrl + status', async () => {
    lib.connectStart.mockResolvedValue({ linkUrl: 'https://connect.composio.dev/link/x', connection: { status: 'initializing' } });
    const res = await post({ action: 'connect', toolkit: 'linear' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.linkUrl).toContain('connect.composio.dev');
    expect(json.data.status).toBe('initializing');
    expect(lib.connectStart).toHaveBeenCalledWith('demo', 'linear');
  });

  it('status → returns polled status', async () => {
    lib.connectPoll.mockResolvedValue({ status: 'active' });
    const res = await post({ action: 'status', toolkit: 'linear' });
    expect((await res.json()).data.status).toBe('active');
    expect(lib.connectPoll).toHaveBeenCalledWith('demo', 'linear');
  });

  it('disconnect → returns disconnected status', async () => {
    lib.disconnect.mockResolvedValue({ status: 'disconnected' });
    const res = await post({ action: 'disconnect', toolkit: 'linear' });
    expect((await res.json()).data.status).toBe('disconnected');
    expect(lib.disconnect).toHaveBeenCalledWith('demo', 'linear');
  });

  it('401 on POST when auth rejects', async () => {
    requireAllowedUser.mockRejectedValue(new FakeUnauthorized());
    const res = await post({ action: 'connect', toolkit: 'linear' });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
  });

  it('422 on missing toolkit', async () => {
    const res = await post({ action: 'connect' });
    expect(res.status).toBe(422);
  });

  it('422 on unknown action', async () => {
    const res = await post({ action: 'frobnicate', toolkit: 'linear' });
    expect(res.status).toBe(422);
  });
});

describe('POST body validation', () => {
  it('422 on invalid JSON body', async () => {
    const res = await POST(
      new Request('http://localhost/api/projects/demo/composio', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      }),
      { params },
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('validation');
  });
});

describe('POST error mapping', () => {
  it('NotFoundError → 404', async () => {
    lib.connectStart.mockRejectedValue(new NotFoundError('project', 'demo'));
    expect((await post({ action: 'connect', toolkit: 'linear' })).status).toBe(404);
  });

  it('ValidationError → 422', async () => {
    lib.connectStart.mockRejectedValue(new ValidationError('toolkit', 'unknown toolkit: x'));
    expect((await post({ action: 'connect', toolkit: 'x' })).status).toBe(422);
  });

  it('ComposioApiError → its status (or 502)', async () => {
    lib.connectStart.mockRejectedValue(new ComposioApiError('composio down'));
    const res = await post({ action: 'connect', toolkit: 'linear' });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('composio_api_error');
  });
});

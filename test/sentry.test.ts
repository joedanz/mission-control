// ABOUTME: Unit tests for sentryProjectRef — maps a project + SENTRY_ORG env to a Sentry ref.

import { describe, it, expect, afterEach } from 'vitest';
import { sentryProjectRef } from '../lib/sentry';

describe('sentryProjectRef', () => {
  const saved = process.env.SENTRY_ORG;
  afterEach(() => { if (saved === undefined) delete process.env.SENTRY_ORG; else process.env.SENTRY_ORG = saved; });

  it('returns null when no slug', () => {
    process.env.SENTRY_ORG = 'acme';
    expect(sentryProjectRef({ sentryProjectSlug: null })).toBeNull();
  });

  it('returns null when SENTRY_ORG is unset', () => {
    delete process.env.SENTRY_ORG;
    expect(sentryProjectRef({ sentryProjectSlug: 'web' })).toBeNull();
  });

  it('returns {org, project} when both present', () => {
    process.env.SENTRY_ORG = 'acme';
    expect(sentryProjectRef({ sentryProjectSlug: 'web' })).toEqual({ org: 'acme', project: 'web' });
  });
});

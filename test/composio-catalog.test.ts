// ABOUTME: Pins the static Composio toolkit catalog — supported slugs + non-empty allow-lists.

import { describe, it, expect } from 'vitest';
import { COMPOSIO_CATALOG, getCatalogEntry, catalogSlugs, allowedToolsFor } from '../lib/composio-catalog';

describe('Composio catalog', () => {
  it('seeds linear and slack with non-empty allow-lists', () => {
    expect(catalogSlugs()).toEqual(['linear', 'slack']);
    for (const slug of catalogSlugs()) {
      const e = COMPOSIO_CATALOG[slug];
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.allowedTools.length).toBeGreaterThan(0);
    }
  });

  it('getCatalogEntry returns null for unknown slugs', () => {
    expect(getCatalogEntry('linear')?.name).toBe('Linear');
    expect(getCatalogEntry('nope')).toBeNull();
  });
});

describe('allowedToolsFor', () => {
  it('returns the curated tool list for a known toolkit', () => {
    expect(allowedToolsFor('linear')).toContain('LINEAR_CREATE_LINEAR_ISSUE');
    expect(allowedToolsFor('linear').length).toBeGreaterThan(0);
  });
  it('returns [] for an uncurated toolkit (Composio expands [] to all tools)', () => {
    expect(allowedToolsFor('github')).toEqual([]);
    expect(allowedToolsFor('totally-unknown')).toEqual([]);
  });
});

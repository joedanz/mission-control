// ABOUTME: Pins the static Composio toolkit catalog — supported slugs + non-empty allow-lists.

import { describe, it, expect } from 'vitest';
import { COMPOSIO_CATALOG, getCatalogEntry, catalogSlugs } from '../lib/composio-catalog';

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

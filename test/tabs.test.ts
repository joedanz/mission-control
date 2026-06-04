// test/tabs.test.ts
// ABOUTME: Unit tests for resolveActiveTab — the URL-tab → active-key resolver behind TabbedPanels,
// ABOUTME: including alias mapping (legacy ?tab=board → tasks) and fallback to the first tab.

import { describe, it, expect } from 'vitest';
import { resolveActiveTab } from '../lib/tabs';

const KEYS = ['overview', 'tasks', 'workflows'];

describe('resolveActiveTab', () => {
  it('returns the url tab when it is a known key', () => {
    expect(resolveActiveTab('tasks', KEYS)).toBe('tasks');
  });

  it('falls back to the first tab when the url tab is unknown', () => {
    expect(resolveActiveTab('nope', KEYS)).toBe('overview');
  });

  it('falls back to the first tab when there is no url tab', () => {
    expect(resolveActiveTab(null, KEYS)).toBe('overview');
  });

  it('maps an aliased url tab to its target key', () => {
    expect(resolveActiveTab('board', KEYS, { board: 'tasks' })).toBe('tasks');
  });

  it('ignores an alias whose target is not a known key', () => {
    expect(resolveActiveTab('board', ['overview'], { board: 'tasks' })).toBe('overview');
  });

  it('prefers a real key over an alias of the same name', () => {
    expect(resolveActiveTab('tasks', KEYS, { tasks: 'overview' })).toBe('tasks');
  });
});

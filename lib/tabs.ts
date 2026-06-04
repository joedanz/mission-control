// lib/tabs.ts
// ABOUTME: Pure resolver for the project detail tab switcher: maps the ?tab= URL value to an active
// ABOUTME: tab key, honoring an optional alias map (e.g. legacy 'board' → 'tasks') and falling back
// ABOUTME: to the first tab. No React — unit-testable in isolation.

export function resolveActiveTab(
  fromUrl: string | null | undefined,
  keys: string[],
  aliases: Record<string, string> = {},
): string {
  if (fromUrl && keys.includes(fromUrl)) return fromUrl;
  if (fromUrl) {
    const target = aliases[fromUrl];
    if (target && keys.includes(target)) return target;
  }
  return keys[0];
}

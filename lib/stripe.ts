// ABOUTME: Maps a project (stripeSite) to a Stripe metadata.site filter. The sentryProjectRef analog.

export type StripeSiteRef = { site: string };

/** A project's Stripe site ref, or null when unmapped (no stripeSite set). */
export function stripeSiteRef(p: { stripeSite: string | null }): StripeSiteRef | null {
  if (!p.stripeSite) return null;
  return { site: p.stripeSite };
}

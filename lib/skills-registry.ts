// ABOUTME: skills.sh registry client for skill DISCOVERY. Uses the public, UNAUTHENTICATED GET /api/search
// ABOUTME: endpoint — the same one the `npx skills` CLI uses. The documented /api/v1/* endpoints require a
// ABOUTME: Vercel OIDC token (mc runs locally, off-Vercel) and are intentionally NOT used here. No DB, no SDK,
// ABOUTME: plain fetch, thin projection type. Install (lib/skills-install.ts) fetches content from GitHub.

import { ValidationError } from './validation';

/** The registry origin, read at call time so SKILLS_API_URL (tests / staging) is honored without a reimport.
 *  Mirrors the `npx skills` CLI's SKILLS_API_URL knob. */
function registryBase(): string {
  return process.env.SKILLS_API_URL || 'https://skills.sh';
}

export class SkillsRegistryError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'SkillsRegistryError';
  }
}

/** A skill as shown in `mc skill search` — a thin projection of the /api/search row. */
export type RegistrySkill = {
  /** Stable identifier, "owner/repo/slug". */
  id: string;
  /** The skill's directory name once installed (and the `<dir>/<slug>/SKILL.md` discovery name). */
  slug: string;
  /** Human-readable name. */
  name: string;
  /** The GitHub repo to install from, "owner/repo". */
  source: string;
  /** Total deduplicated install count (registry's popularity signal). */
  installs: number;
};

type RawSearchSkill = { id?: string; skillId?: string; name?: string; installs?: number; source?: string };

/** Split a registry id ("owner/repo/slug" — possibly with a deeper subpath) into its repo `source`
 *  ("owner/repo") and `slug` (the trailing segment). Returns null when it isn't at least owner/repo/slug.
 *  Pure — shared with the installer so id parsing has one definition. */
export function parseRegistryId(id: string): { source: string; slug: string } | null {
  const parts = id.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  return { source: `${parts[0]}/${parts[1]}`, slug: parts[parts.length - 1] };
}

function projectSkill(raw: RawSearchSkill): RegistrySkill | null {
  const id = (raw.id ?? '').trim();
  const parsed = id ? parseRegistryId(id) : null;
  const slug = raw.skillId ?? parsed?.slug ?? '';
  const source = raw.source ?? parsed?.source ?? '';
  if (!id || !slug) return null;
  return { id, slug, name: raw.name ?? slug, source, installs: raw.installs ?? 0 };
}

/** Search the skills.sh registry by free-text query. One page, popularity-sorted — a browse command, not an
 *  export. Hits the unauthenticated GET /api/search (no auth header). Throws ValidationError for a query under
 *  2 chars (the API's own floor) and SkillsRegistryError on transport / non-2xx. */
export async function searchSkills(opts: { q: string; limit?: number }): Promise<RegistrySkill[]> {
  const q = (opts.q ?? '').trim();
  if (q.length < 2) throw new ValidationError('q', 'search query must be at least 2 characters');
  const params = new URLSearchParams({ q });
  params.set('limit', String(opts.limit ?? 10));
  const url = `${registryBase()}/api/search?${params.toString()}`;

  let res: { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
  try {
    res = await fetch(url);
  } catch (e) {
    throw new SkillsRegistryError(`skills.sh request failed: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SkillsRegistryError(`skills.sh ${res.status}: ${body.slice(0, 300)}`, res.status);
  }
  const j = (await res.json()) as { skills?: RawSearchSkill[] };
  return (j.skills ?? [])
    .map(projectSkill)
    .filter((s): s is RegistrySkill => s !== null)
    .sort((a, b) => (b.installs || 0) - (a.installs || 0));
}

// ABOUTME: Single source of truth for the sign-in allowlist.
// ABOUTME: Fail-closed — an unset/empty ALLOWED_EMAIL rejects everyone.

export const ALLOWED_EMAIL = (process.env.ALLOWED_EMAIL ?? '').toLowerCase().trim();

export function isAllowed(email: string | null | undefined): boolean {
  if (!ALLOWED_EMAIL) return false;
  if (!email) return false;
  return email.toLowerCase().trim() === ALLOWED_EMAIL;
}

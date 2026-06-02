// ABOUTME: Framework-agnostic validation + slug helpers shared by the web actions and the CLI.
// ABOUTME: No `server-only`, no Next imports — safe to import from cli/index.ts.

/** Lowercase, hyphenate, trim. The single source of truth for project slugs. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Thrown when an enum/argument is invalid. Carries the field + allowed values so the
 *  CLI can emit an agent-actionable message (and exit code 2). */
export class ValidationError extends Error {
  readonly field: string;
  readonly allowed?: readonly string[];
  constructor(field: string, message: string, allowed?: readonly string[]) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.allowed = allowed;
  }
}

/** Thrown when a referenced row doesn't exist (CLI maps to exit code 3). */
export class NotFoundError extends Error {
  readonly kind: string;
  readonly key: string;
  constructor(kind: string, key: string, hint?: string) {
    super(`No ${kind} "${key}"${hint ? ` — ${hint}` : ''}`);
    this.name = 'NotFoundError';
    this.kind = kind;
    this.key = key;
  }
}

/** Thrown when an optimistic-concurrency (version CAS) write loses to a concurrent writer.
 *  The CLI maps this to exit code 1 (CONFLICT) — distinct from NotFound (exit 3). */
export class ConflictError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = 'ConflictError';
    this.kind = kind;
  }
}

/** Assert `value` is one of `allowed`, returning the narrowed type. Throws ValidationError
 *  with a message that lists the valid values so an agent can self-correct in one step. */
export function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  field: string,
): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ValidationError(
    field,
    `Invalid ${field} "${value}". Valid: ${allowed.join(', ')}`,
    allowed,
  );
}

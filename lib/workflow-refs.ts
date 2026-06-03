// ABOUTME: Pure {{nodeId.field}} data-passing references (slice 3) — the single source of truth for how a
// ABOUTME: downstream agent node consumes an upstream node's captured output. extractRefs parses the tokens
// ABOUTME: (used by validateGraph + the walker); normalizeStepOutput/resolveRef/interpolate resolve them at
// ABOUTME: run time against a step's stored output. No DB, no spawn, no React (mirrors lib/workflows.ts).

// {{nodeId.path}} — nodeId has no dots; path is a dotted chain (e.g. result, output, output.foo.bar, status).
// Inner whitespace is tolerated; literal <a.b> / {a.b} do NOT match (must be double braces).
const REF_RE = /\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_][A-Za-z0-9_.]*?)\s*\}\}/g;

export type Ref = { raw: string; nodeId: string; path: string };

/** Every {{nodeId.path}} token in `text`, in order. `raw` is the exact matched token (for replacement). */
export function extractRefs(text: string): Ref[] {
  const refs: Ref[] = [];
  for (const m of text.matchAll(REF_RE)) refs.push({ raw: m[0], nodeId: m[1], path: m[2] });
  return refs;
}

// The clean view a reference resolves against. `result` = the agent's free text; `output` = its
// schema-validated structured_output; `status` = the linked run's terminal status.
export type RefView = { result: string | null; output: unknown; status: string | null };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Project a step's stored `output` (jsonb: { runId, runStatus, result: <claude result line> | null, … })
 *  into the resolvable RefView. Defensive — a trigger/stub/exec step (no claude result line) yields nulls. */
export function normalizeStepOutput(stored: unknown): RefView {
  const s = isObject(stored) ? stored : {};
  const line = isObject(s.result) ? s.result : null; // the captured claude `--output-format json` result line
  const result = line && typeof line.result === 'string' ? line.result : null;
  const output = line && line.structured_output !== undefined ? line.structured_output : null;
  const status = typeof s.runStatus === 'string' ? s.runStatus : null;
  return { result, output, status };
}

/** Resolve a dotted `path` (e.g. `output.foo.bar`) against a RefView. A null/undefined terminal value, an
 *  unknown root, or a missing key all report `found: false` (the caller hard-fails the node). */
export function resolveRef(view: RefView, path: string): { found: boolean; value: unknown } {
  const [root, ...rest] = path.split('.');
  let cur: unknown;
  if (root === 'result') cur = view.result;
  else if (root === 'output') cur = view.output;
  else if (root === 'status') cur = view.status;
  else return { found: false, value: undefined };

  for (const key of rest) {
    if (!isObject(cur) || !(key in cur)) return { found: false, value: undefined };
    cur = cur[key];
  }
  if (cur === undefined || cur === null) return { found: false, value: undefined };
  return { found: true, value: cur };
}

/** Splice a resolved value into prompt text: strings as-is, everything else JSON-stringified. */
function render(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Replace every {{nodeId.path}} in `text` with its resolved value from `viewsByNodeId`. Unresolved refs
 *  (unknown node, unknown root, missing key, null value) are LEFT in place and collected in `missing` — the
 *  walker treats a non-empty `missing` as a hard failure of the referencing node. */
export function interpolate(text: string, viewsByNodeId: Map<string, RefView>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(REF_RE, (raw, nodeId: string, path: string) => {
    const view = viewsByNodeId.get(nodeId);
    const resolved = view ? resolveRef(view, path) : { found: false, value: undefined };
    if (!resolved.found) {
      missing.push(raw);
      return raw; // untouched — the caller fails the node, so the substituted text never reaches a spawn
    }
    return render(resolved.value);
  });
  return { text: out, missing };
}

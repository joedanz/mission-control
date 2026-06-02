// ABOUTME: Per-model token pricing for the telemetry hooks — turns a transcript message's usage into
// ABOUTME: micro-dollars. Plain ESM (hooks run unbuilt). Cost is priced HERE, per message, because the
// ABOUTME: model lives on each transcript message (runs.model is null — session-start sends no model).
//
// ⚠️ RATES ARE LIST-PRICE ESTIMATES (USD per 1M tokens) last set 2026-05-29. VERIFY + EDIT HERE against
//    https://platform.claude.com/docs/en/docs/about-claude/pricing — this table is the single source of
//    truth for dollar figures. Tiers are matched by substring, FIRST match wins, so order them
//    specific → general (the opus-4.5+ row must precede the legacy /opus/ fallback). An unknown model
//    prices to 0 (never fabricate cost). A new major (e.g. opus-5) needs its own row added above /opus/.
//
// A rate in USD-per-million-tokens equals MICRO-DOLLARS-PER-TOKEN (1e6 micros/$ ÷ 1e6 tokens/M), so the
// numbers below are used directly as micros-per-token. cacheRead ≈ 0.1× input; cache writes have two TTLs:
// 5-minute ≈ 1.25× input (`cacheWrite`), 1-hour ≈ 2× input (`cacheWrite1h`).

const TIERS = [
  // Opus 4.5+ (incl. the running claude-opus-4-8) — Anthropic cut Opus list price ~3× starting at 4.5.
  // The \b stops a date-suffixed legacy id (claude-opus-4-20250514 = Opus 4.0) matching "4-20" as 4.20.
  { match: /opus-4-(?:[5-9]|[1-9]\d)\b/i, input: 5,  output: 25, cacheRead: 0.5, cacheWrite: 6.25,  cacheWrite1h: 10 },
  // Legacy Opus (4.1, 4.0, 3.x) stayed at the old rate; substring fallback for any other opus.
  { match: /opus/i,                       input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 },
  { match: /sonnet/i, input: 3,  output: 15, cacheRead: 0.3,  cacheWrite: 3.75, cacheWrite1h: 6 },
  { match: /haiku/i,  input: 1,  output: 5,  cacheRead: 0.1,  cacheWrite: 1.25, cacheWrite1h: 2 },
];

/** Micro-dollars for one transcript message's usage, priced by its model. 0 for an unknown/absent model
 *  or missing usage (so cost is "best known", never fabricated). Cache writes are split by TTL: the
 *  `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` breakdown is priced at the 5m/1h rates;
 *  when that breakdown is absent the flat `cache_creation_input_tokens` is priced at the 5m rate. */
export function priceMessageMicros(model, usage) {
  if (!model || !usage) return 0;
  const tier = TIERS.find((t) => t.match.test(model));
  if (!tier) return 0;
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cc = usage.cache_creation;
  const writeMicros = cc
    ? (cc.ephemeral_5m_input_tokens || 0) * tier.cacheWrite + (cc.ephemeral_1h_input_tokens || 0) * tier.cacheWrite1h
    : (usage.cache_creation_input_tokens || 0) * tier.cacheWrite;
  return Math.round(inTok * tier.input + outTok * tier.output + cacheRead * tier.cacheRead + writeMicros);
}

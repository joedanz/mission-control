// ABOUTME: Unit tests for the daemon runner's pure helpers. parseResultMetrics turns a `claude -p
// ABOUTME: --output-format json` result into AUTHORITATIVE run metrics (claude's own total_cost_usd + usage),
// ABOUTME: which the daemon records to override the hooks' transcript ESTIMATE. No DB / no spawn.

import { describe, it, expect } from 'vitest';
import { parseResultMetrics } from '../daemon/runner';

describe('parseResultMetrics (pure)', () => {
  const result = {
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.2205297,
    usage: { input_tokens: 21, output_tokens: 549, cache_read_input_tokens: 87012, cache_creation_input_tokens: 167250 },
  };

  it("extracts claude's authoritative cost (→ micros) and usage from the result line", () => {
    expect(parseResultMetrics(JSON.stringify(result))).toEqual({
      costMicros: 220530, // round(0.2205297 * 1e6)
      tokensIn: 21,
      tokensOut: 549,
      cacheReadTokens: 87012,
      cacheWriteTokens: 167250,
    });
  });

  it('finds the result among other stdout lines (last result wins)', () => {
    const out = ['{"type":"system","subtype":"init"}', 'some stray log line', JSON.stringify(result)].join('\n');
    expect(parseResultMetrics(out)?.costMicros).toBe(220530);
    expect(parseResultMetrics(out)?.tokensOut).toBe(549);
  });

  it('returns null when there is no result JSON (exec/stub output, empty, or non-JSON)', () => {
    expect(parseResultMetrics('')).toBeNull();
    expect(parseResultMetrics('hello\nworld')).toBeNull();
    expect(parseResultMetrics('{"type":"assistant","message":{}}')).toBeNull(); // no total_cost_usd
  });

  it('tolerates a missing usage block (cost only)', () => {
    expect(parseResultMetrics(JSON.stringify({ type: 'result', total_cost_usd: 0.5 }))).toEqual({
      costMicros: 500000,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

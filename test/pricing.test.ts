// ABOUTME: Unit tests for hook cost pricing — priceMessageMicros (tiers/math/safety) and the
// ABOUTME: sumTranscriptTokens integration that prices a real .jsonl transcript per message. No DB.

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { priceMessageMicros } from '../hooks/pricing.mjs';
import { sumTranscriptTokens } from '../hooks/_lib.mjs';

describe('priceMessageMicros', () => {
  it('prices opus 4.5+ input+output at the current $5/$25 rate (micros/token = $/Mtok)', () => {
    // 1000*5 + 500*25 = 5000 + 12500
    expect(priceMessageMicros('claude-opus-4-8', { input_tokens: 1000, output_tokens: 500 })).toBe(17500);
  });

  it('prices opus 4.5+ cache read + write', () => {
    // 1000*5 + 2000*0.5 + 100*6.25 = 5000 + 1000 + 625
    expect(
      priceMessageMicros('claude-opus-4-8', { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 }),
    ).toBe(6625);
  });

  it('prices sonnet and haiku tiers', () => {
    expect(priceMessageMicros('claude-sonnet-4-6', { input_tokens: 1000, output_tokens: 1000 })).toBe(18000); // 3k + 15k
    expect(priceMessageMicros('claude-haiku-4-5-20251001', { input_tokens: 1000, output_tokens: 1000 })).toBe(6000); // 1k + 5k
  });

  it('matches a tier by substring, so older model ids still price', () => {
    expect(priceMessageMicros('claude-3-5-sonnet-20241022', { input_tokens: 100 })).toBe(300); // sonnet
  });

  // The opus split: 4.5+ is $5/$25, but legacy Opus (4.1, 4.0, 3.x) stayed at $15/$75. The matcher
  // must route by version, and crucially must NOT mistake a date-suffixed legacy id for a 4.5+ minor.
  describe('opus 4.5+ vs legacy opus tier split', () => {
    const inputOnly = { input_tokens: 1000 };
    it('routes opus 4.5–4.9 and 4.10+ to the $5 tier', () => {
      expect(priceMessageMicros('claude-opus-4-8', inputOnly)).toBe(5000); // 1000*5
      expect(priceMessageMicros('claude-opus-4-5', inputOnly)).toBe(5000);
      expect(priceMessageMicros('claude-opus-4-10', inputOnly)).toBe(5000); // hypothetical 4.10
    });
    it('routes legacy opus to the $15 tier', () => {
      expect(priceMessageMicros('claude-opus-4-1-20250805', inputOnly)).toBe(15000); // Opus 4.1
      expect(priceMessageMicros('claude-3-opus-20240229', inputOnly)).toBe(15000); // Opus 3
    });
    it('does NOT misread a date-suffixed Opus 4.0 id ("4-20250514") as minor 4.20 → legacy $15', () => {
      // The \b in the matcher is load-bearing here: "opus-4-20250514" must not match "opus-4-20".
      expect(priceMessageMicros('claude-opus-4-20250514', inputOnly)).toBe(15000);
    });
  });

  it('prices the cache_creation TTL split: 5m at 1.25× input, 1h at 2× input', () => {
    // opus 4.5+: 5m 100*6.25 + 1h 200*10 = 625 + 2000
    expect(
      priceMessageMicros('claude-opus-4-8', {
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      }),
    ).toBe(2625);
  });

  it('falls back to the flat cache_creation_input_tokens at the 5m rate when no TTL breakdown is present', () => {
    // no cache_creation object → flat 100 tokens priced at the 5m write rate (6.25)
    expect(priceMessageMicros('claude-opus-4-8', { cache_creation_input_tokens: 100 })).toBe(625);
  });

  it('never fabricates cost: unknown model, null model, or null usage → 0', () => {
    expect(priceMessageMicros('gpt-4', { input_tokens: 1000 })).toBe(0);
    expect(priceMessageMicros(null as unknown as string, { input_tokens: 1000 })).toBe(0);
    expect(priceMessageMicros('claude-opus-4-8', null as unknown as Record<string, number>)).toBe(0);
  });
});

describe('sumTranscriptTokens', () => {
  let path: string | null = null;
  afterEach(() => { if (path) { rmSync(path, { force: true }); path = null; } });

  it('sums tokens AND prices cost per message from a transcript, skipping non-usage/malformed lines', () => {
    path = join(tmpdir(), `mc-transcript-test-${Date.now()}.jsonl`);
    writeFileSync(path, [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 500 } } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }), // no usage → skipped
      '{ not json',                                                                  // malformed → skipped
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 200, output_tokens: 100 } } }),
    ].join('\n'));

    const t = sumTranscriptTokens(path);
    expect(t.tokensIn).toBe(1200);   // 1000 + 200
    expect(t.tokensOut).toBe(600);   // 500 + 100
    // opus 4.5+: 1000*5 + 500*25 = 17500 ; sonnet: 200*3 + 100*15 = 2100
    expect(t.costMicros).toBe(19600);
  });

  it('counts each assistant message ONCE when the transcript repeats its line (streaming dupes)', () => {
    // Claude Code writes multiple .jsonl lines per assistant message (one per content block / stream step),
    // each echoing the SAME message.id and the FULL message.usage. Summing every line triple-counts tokens
    // and cost. Real example: a haiku check-in whose 4 messages appeared on 8 lines billed ~3.7× actual.
    path = join(tmpdir(), `mc-transcript-dupes-${Date.now()}.jsonl`);
    const msg = { type: 'assistant', message: { id: 'msg_ABC', model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 247, cache_creation_input_tokens: 80000 } } };
    writeFileSync(path, [JSON.stringify(msg), JSON.stringify(msg), JSON.stringify(msg)].join('\n')); // same message, 3 lines
    const t = sumTranscriptTokens(path);
    expect(t.tokensIn).toBe(10); // not 30
    expect(t.tokensOut).toBe(247); // not 741
    expect(t.cacheWriteTokens).toBe(80000); // not 240000
    // haiku: 10*1 + 247*5 + 80000*1.25 = 10 + 1235 + 100000
    expect(t.costMicros).toBe(101245);
  });

  it('still counts distinct messages that share no id (id-less lines are each real)', () => {
    path = join(tmpdir(), `mc-transcript-noid-${Date.now()}.jsonl`);
    writeFileSync(path, [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 20 } } }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 5, output_tokens: 7 } } }),
    ].join('\n'));
    const t = sumTranscriptTokens(path);
    expect(t.tokensIn).toBe(15); // both counted — no id to dedup on
    expect(t.tokensOut).toBe(27);
  });

  it('returns zeroed totals for a missing transcript path', () => {
    const t = sumTranscriptTokens(undefined as unknown as string);
    expect(t).toEqual({ tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 });
  });
});

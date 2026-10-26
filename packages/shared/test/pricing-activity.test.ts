import { describe, expect, it } from 'vitest';
import { activityStats, aggregateDaily, contributionDays, CONTRIBUTION_DAYS, compactPriceList, estimateCost, findPrice, type UsageRecord } from '../src/index.ts';

// Shape copied from LiteLLM's model_prices_and_context_window.json entries (values as of 2026-10-25).
const table = compactPriceList({
  'claude-opus-5-5': { input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 5e-6, mode: 'chat' },
  'gpt-5': { input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1.25e-7, mode: 'chat' },
  'xai/grok-code-fast-1': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6, mode: 'chat' },
  'some-embedding': { input_cost_per_token: 1e-7, mode: 'embedding' },
  sample_spec: { max_tokens: 'set to max' },
});

const rec = (over: Partial<UsageRecord>): UsageRecord => ({
  provider: 'claude_code', model_id: 'claude-opus-5-5', occurred_at: '2026-10-01T10:00:00.000Z', session_id: 's', input_tokens: 1000,
  output_tokens: 2000, cache_read_tokens: 100000, cache_write_tokens: 5000, usage_source: 'claude_code_jsonl', measurement_type: 'measured',
  billing_mode: 'subscription', dedupe_key: 'k', event_count: 1, synced_at: null, provider_fields: {}, ...over,
});

describe('pricing', () => {
  it('keeps only priced models and matches exact ids or provider prefixes, never fuzzy', () => {
    expect(Object.keys(table).sort()).toEqual(['claude-opus-5-5', 'gpt-5', 'xai/grok-code-fast-1']);
    expect(findPrice(table, 'grok-code-fast-1')).not.toBeNull();
    expect(findPrice(table, 'openai/gpt-5')).not.toBeNull(); // OpenRouter-style id
    expect(findPrice(table, 'claude-4.5-sonnet-thinking')).toBeNull(); // Cursor's own name
    expect(findPrice(table, 'claude-opus-5')).toBeNull();
  });

  it('estimates at list prices including cache tokens', () => {
    // 1000×4e-6 + 2000×2e-5 + 100000×2e-7 + 5000×5e-6 = 0.004 + 0.04 + 0.02 + 0.025
    expect(estimateCost(table, rec({}))).toBeCloseTo(0.089, 9);
    expect(estimateCost(table, rec({ model_id: 'unknown-model' }))).toBeNull();
  });

  it('prefers billed and tool-reported costs over list-price estimates when aggregating', () => {
    const { buckets } = aggregateDaily([
      rec({ dedupe_key: 'a' }),
      rec({ dedupe_key: 'b', provider: 'openrouter', usage_source: 'openrouter_activity', model_id: 'openai/gpt-5', cost_usd: 0.5, cost_kind: 'billed', event_count: 3 }),
      rec({ dedupe_key: 'c', model_id: 'mystery' }),
    ], () => true, table);
    const cc = buckets.find((b) => b.model_id === 'claude-opus-5-5')!;
    expect(cc.cost_usd).toBeCloseTo(0.089, 6);
    expect(cc.billed_cost_usd).toBeNull();
    expect(buckets.find((b) => b.model_id === 'mystery')).toMatchObject({ cost_usd: null, unpriced_events: 1 });
    const or = buckets.find((b) => b.provider === 'openrouter')!;
    expect(or).toMatchObject({ cost_usd: 0.5, billed_cost_usd: 0.5, unpriced_events: 0 });
  });
});

describe('activity stats', () => {
  const d = (day: string, events = 1, tokens = 100) => ({ day, events, tokens });

  it('finds the best day and the longest streak across gaps', () => {
    const s = activityStats([d('2026-10-01'), d('2026-10-02', 3, 900), d('2026-10-03'), d('2026-10-05'), d('2026-10-06')], '2026-10-20');
    expect(s.bestDay).toEqual({ day: '2026-10-02', events: 3, tokens: 900 });
    expect(s.longestStreak).toBe(3);
    expect(s.longestStreakEnd).toBe('2026-10-03');
    expect(s.currentStreak).toBe(0);
    expect(s.activeDays).toBe(5);
  });

  it('keeps the current streak alive through today if yesterday was active', () => {
    expect(activityStats([d('2026-10-18'), d('2026-10-19')], '2026-10-20').currentStreak).toBe(2);
    expect(activityStats([d('2026-10-18'), d('2026-10-19'), d('2026-10-20')], '2026-10-20').currentStreak).toBe(3);
    expect(activityStats([d('2026-10-18')], '2026-10-20').currentStreak).toBe(0);
  });

  it('merges multiple tools on the same day and ignores zero-request rows', () => {
    const s = activityStats([d('2026-10-01', 1, 10), d('2026-10-01', 2, 30), d('2026-10-02', 0, 0)], '2026-10-01');
    expect(s.bestDay).toEqual({ day: '2026-10-01', events: 3, tokens: 40 });
    expect(s.activeDays).toBe(1);
  });
});

import { uploadModelId } from '../src/index.ts';

describe('contribution days', () => {
  const today = '2026-10-26';
  const days = [
    { day: '2025-10-01', events: 3, tokens: 30 }, // older than the window
    { day: '2025-10-21', events: 1, tokens: 10 }, // first day in the window (today - 370)
    { day: '2026-03-02', events: 0, tokens: 0 }, // no requests: not active
    { day: '2026-10-25', events: 2, tokens: 5 },
    { day: '2026-10-25', events: 1, tokens: 7 }, // same day from another source
    { day: '2026-10-27', events: 4, tokens: 1 }, // in the future
  ];
  it('keeps the last 52 weeks of active days, merged per day, oldest first', () => {
    expect(CONTRIBUTION_DAYS).toBe(371);
    expect(contributionDays(days, true, today)).toEqual([
      { day: '2025-10-21', events: 1, tokens: 10 },
      { day: '2026-10-25', events: 3, tokens: 12 },
    ]);
  });
  it('leaves tokens out unless token totals are public', () => {
    expect(contributionDays(days, false, today)).toEqual([
      { day: '2025-10-21', events: 1 },
      { day: '2026-10-25', events: 3 },
    ]);
  });
});

describe('uploadModelId', () => {
  it('keeps normal and provider-prefixed ids verbatim', () => {
    expect(uploadModelId('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(uploadModelId('openai/gpt-4.1')).toBe('openai/gpt-4.1');
  });
  it('reduces local file paths to the file name and caps length', () => {
    expect(uploadModelId('/Users/me/models/qwen3-coder.gguf')).toBe('qwen3-coder.gguf');
    expect(uploadModelId('~/llm/foo.bin')).toBe('foo.bin');
    expect(uploadModelId('C:\\Users\\x\\m\\phi.gguf')).toBe('phi.gguf');
    expect(uploadModelId('x'.repeat(500))).toHaveLength(200);
  });
});

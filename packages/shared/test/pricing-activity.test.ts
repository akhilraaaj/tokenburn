import { describe, expect, it } from 'vitest';
import { activityStats, aggregateDaily, contributionDays, CONTRIBUTION_DAYS, compactPriceList, cursorPriceIds, estimateCost, findPrice, type UsageRecord } from '../src/index.ts';

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

describe('Cursor model names', () => {
  const t = compactPriceList({
    'claude-opus-5-5': { input_cost_per_token: 4e-6, output_cost_per_token: 2e-5, cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 5e-6 },
    'claude-sonnet-4-5': { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
    'xai/grok-4.6': { input_cost_per_token: 2e-6, output_cost_per_token: 6e-6 },
    'xai/grok-4-fast': { input_cost_per_token: 2e-7, output_cost_per_token: 5e-7 },
    'xai/grok-4': { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
    'gemini-2.5-flash': { input_cost_per_token: 3e-7, output_cost_per_token: 2.5e-6 },
  });
  const cur = (model_id: string) => rec({ provider: 'cursor', usage_source: 'cursor_csv', model_id, session_id: null });

  it('looks Cursor names up under the model itself, most specific first', () => {
    expect(cursorPriceIds('claude-4.5-sonnet-thinking')).toEqual(['claude-4.5-sonnet-thinking', 'claude-sonnet-4-5-thinking', 'claude-sonnet-4-5']);
    expect(cursorPriceIds('cursor-grok-4.6-high-fast')).toEqual(['cursor-grok-4.6-high-fast', 'grok-4.6-high-fast', 'grok-4.6-high', 'grok-4.6']);
    expect(cursorPriceIds('claude-opus-5-5-high-fast').at(-1)).toBe('claude-opus-5-5');
  });

  it('prices named Cursor models and keeps a suffixed model that is really listed', () => {
    expect(estimateCost(t, cur('claude-opus-5-5-high-fast'))).toBeCloseTo(0.089, 9); // same tokens as the Claude Code row
    expect(estimateCost(t, cur('cursor-grok-4.6-xhigh'))).not.toBeNull();
    expect(estimateCost(t, cur('gemini-2.5-flash'))).not.toBeNull();
    // grok-4-fast is its own (cheaper) model, so it must not fall back to grok-4's price.
    expect(estimateCost(t, cur('grok-4-fast-high'))).toBeCloseTo(1000 * 2e-7 + 2000 * 5e-7 + 100000 * 2e-7 + 5000 * 2e-7, 9);
  });

  it("leaves Cursor's own models and auto unpriced", () => {
    for (const m of ['auto', 'default', 'composer-2.5-fast', 'grok-bot-automation', 'agent_review']) expect(estimateCost(t, cur(m))).toBeNull();
  });

  it('never translates names from other sources', () => {
    expect(estimateCost(t, rec({ model_id: 'claude-opus-5-5-high-fast' }))).toBeNull();
    expect(estimateCost(t, rec({ provider: 'openrouter', usage_source: 'openrouter_activity', model_id: 'claude-4.5-sonnet-thinking' }))).toBeNull();
  });

  it('keeps the same model used through Claude Code and Cursor apart, each priced once', () => {
    const { buckets } = aggregateDaily([rec({ dedupe_key: 'cc' }), { ...cur('claude-opus-5-5-high-fast'), dedupe_key: 'cur' }], () => true, t);
    expect(buckets).toHaveLength(2);
    expect(buckets.map((b) => `${b.provider}:${b.model_id}`).sort()).toEqual(['claude_code:claude-opus-5-5', 'cursor:claude-opus-5-5-high-fast']);
    for (const b of buckets) expect(b).toMatchObject({ unpriced_events: 0 });
    expect(buckets.reduce((a, b) => a + (b.cost_usd ?? 0), 0)).toBeCloseTo(0.178, 6);
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

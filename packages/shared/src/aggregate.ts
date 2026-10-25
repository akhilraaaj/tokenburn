// Daily aggregation of normalized records. Days are UTC.
import { uploadModelId } from './models.ts';
import { estimateCost, type PriceTable } from './pricing.ts';
import type { BillingMode, MeasurementType, Provider, UsageRecord, UsageSource } from './schema.ts';

export interface DailyBucket {
  provider: Provider;
  usage_source: UsageSource;
  model_id: string;
  day: string; // YYYY-MM-DD (UTC)
  billing_mode: BillingMode;
  measurement_type: MeasurementType;
  event_count: number;
  /** Sum over events that reported the field; null when no event in the bucket reported it. */
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  /** Events missing input or output tokens (cache fields are optional; not every tool reports them). */
  incomplete_events: number;
  /**
   * Best-known cost in USD: the tool's billed amount, else the tool's own estimate, else an
   * API-equivalent estimate from the public price list. Null when nothing in the bucket could be priced.
   */
  cost_usd: number | null;
  /** The part of cost_usd that is an actual charge reported by the provider (OpenRouter). */
  billed_cost_usd: number | null;
  /** Events with no cost from any of the above. */
  unpriced_events: number;
  session_count: number | null;
}

export interface SessionSummary {
  provider: Provider;
  session_id: string;
  first_at: string;
  last_at: string;
  event_count: number;
}

export const bucketKey = (b: Pick<DailyBucket, 'provider' | 'usage_source' | 'model_id' | 'day' | 'billing_mode' | 'measurement_type'>) =>
  [b.provider, b.usage_source, b.model_id, b.day, b.billing_mode, b.measurement_type].join('\u0001');

const addNullable = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);

export function aggregateDaily(records: Iterable<UsageRecord>, sessionsSupported: (s: UsageSource) => boolean, prices: PriceTable = {}) {
  const buckets = new Map<string, DailyBucket>();
  const bucketSessions = new Map<string, Set<string>>();
  const sessions = new Map<string, SessionSummary>();

  for (const r of records) {
    const day = r.occurred_at.slice(0, 10);
    const proto = {
      provider: r.provider, usage_source: r.usage_source, model_id: uploadModelId(r.model_id), day,
      billing_mode: r.billing_mode, measurement_type: r.measurement_type,
    };
    const key = bucketKey(proto);
    let b = buckets.get(key);
    if (!b) {
      b = {
        ...proto, event_count: 0, input_tokens: null, output_tokens: null, cache_read_tokens: null,
        cache_write_tokens: null, incomplete_events: 0, cost_usd: null, billed_cost_usd: null, unpriced_events: 0, session_count: sessionsSupported(r.usage_source) ? 0 : null,
      };
      buckets.set(key, b);
      bucketSessions.set(key, new Set());
    }
    b.event_count += r.event_count;
    b.input_tokens = addNullable(b.input_tokens, r.input_tokens);
    b.output_tokens = addNullable(b.output_tokens, r.output_tokens);
    b.cache_read_tokens = addNullable(b.cache_read_tokens, r.cache_read_tokens);
    b.cache_write_tokens = addNullable(b.cache_write_tokens, r.cache_write_tokens);
    if (r.input_tokens === null || r.output_tokens === null) b.incomplete_events += r.event_count;
    const cost = r.cost_kind && typeof r.cost_usd === 'number' ? r.cost_usd : typeof r.est_cost_usd === 'number' ? r.est_cost_usd : estimateCost(prices, r);
    if (cost === null) b.unpriced_events += r.event_count;
    else b.cost_usd = (b.cost_usd ?? 0) + cost;
    if (r.cost_kind === 'billed' && typeof r.cost_usd === 'number') b.billed_cost_usd = (b.billed_cost_usd ?? 0) + r.cost_usd;

    if (r.session_id && b.session_count !== null) {
      const set = bucketSessions.get(key)!;
      set.add(r.session_id);
      b.session_count = set.size;
      const sk = r.provider + '\u0001' + r.session_id;
      const s = sessions.get(sk);
      if (!s) sessions.set(sk, { provider: r.provider, session_id: r.session_id, first_at: r.occurred_at, last_at: r.occurred_at, event_count: r.event_count });
      else {
        s.event_count += r.event_count;
        if (r.occurred_at < s.first_at) s.first_at = r.occurred_at;
        if (r.occurred_at > s.last_at) s.last_at = r.occurred_at;
      }
    }
  }
  const round = (v: number | null) => (v === null ? null : Math.round(v * 1e6) / 1e6);
  const out = [...buckets.values()].map((b) => ({ ...b, cost_usd: round(b.cost_usd), billed_cost_usd: round(b.billed_cost_usd) }));
  return { buckets: out, sessions: [...sessions.values()] };
}

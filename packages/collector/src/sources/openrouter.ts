// OpenRouter: GET https://openrouter.ai/api/v1/activity with a management key the user keeps locally.
// Returns per-day, per-model, per-endpoint totals for the last 30 completed UTC days.
// Account-scoped: uploaded as server-deduped events so several machines don't double count.
import type { UsageRecord } from '../../../shared/src/index.ts';
import type { Store } from '../store.ts';
import { nonNeg, shortHash } from './sqlite.ts';

export interface OpenRouterActivityRow {
  date: string;
  model: string;
  model_permaslug?: string;
  endpoint_id?: string;
  provider_name?: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  /** USD charged by OpenRouter for these requests. */
  usage?: number;
}

export function activityToRecord(r: OpenRouterActivityRow): UsageRecord | null {
  const requests = nonNeg(r.requests);
  if (!r.date || !/^\d{4}-\d{2}-\d{2}/.test(r.date) || !r.model || !requests) return null;
  const prompt = nonNeg(r.prompt_tokens);
  const cached = nonNeg(r.cached_tokens);
  // cached_tokens is usually a subset of prompt_tokens but can exceed it (replayed response-cache hits);
  // then the uncached share is unknowable, so input stays unknown rather than guessed.
  const input = prompt === null ? null : cached === null ? prompt : cached <= prompt ? prompt - cached : null;
  return {
    provider: 'openrouter',
    model_id: r.model,
    occurred_at: `${r.date.slice(0, 10)}T00:00:00.000Z`,
    session_id: null,
    input_tokens: input,
    output_tokens: nonNeg(r.completion_tokens),
    cache_read_tokens: cached,
    cache_write_tokens: null,
    usage_source: 'openrouter_activity',
    measurement_type: 'measured',
    billing_mode: 'api',
    dedupe_key: `or:${shortHash([r.date.slice(0, 10), r.model_permaslug ?? r.model, r.endpoint_id ?? ''].join('\u0001'))}`,
    event_count: requests,
    cost_usd: typeof r.usage === 'number' && Number.isFinite(r.usage) && r.usage >= 0 ? r.usage : null,
    cost_kind: typeof r.usage === 'number' && Number.isFinite(r.usage) && r.usage >= 0 ? 'billed' : null,
    synced_at: null,
    provider_fields: { reasoning_tokens: nonNeg(r.reasoning_tokens), provider_name: r.provider_name?.slice(0, 40) ?? null },
  };
}

export async function fetchOpenRouterActivity(key: string): Promise<OpenRouterActivityRow[]> {
  const res = await fetch('https://openrouter.ai/api/v1/activity', { headers: { authorization: `Bearer ${key}` } });
  if (res.status === 401 || res.status === 403) throw new Error('OpenRouter rejected the key. /activity needs a management key (openrouter.ai/settings/management-keys).');
  if (!res.ok) throw new Error(`OpenRouter /activity returned ${res.status}`);
  const body = (await res.json()) as { data?: OpenRouterActivityRow[] };
  return Array.isArray(body.data) ? body.data : [];
}

/** Pulls the 30-day window and stores completed days. Days already stored with identical values are skipped. */
export async function collectOpenRouter(store: Store, key: string) {
  const rows = await fetchOpenRouterActivity(key);
  let changed = 0, invalid = 0;
  store.transaction(() => {
    for (const r of rows) {
      const rec = activityToRecord(r);
      if (!rec) { invalid++; continue; }
      if (store.replaceEvent(rec)) changed++;
    }
  });
  store.setMeta('openrouter_activity_last_fetch_at', new Date().toISOString());
  return { rows: rows.length, changed, invalid };
}

import { modelDisplayName, PROVIDER_LABELS, SOURCES, rowTokens, type PublicRow, type UsageSource } from '../../../../packages/shared/src/index.ts';

export const providerLabel = (p?: string) => (p ? PROVIDER_LABELS[p as keyof typeof PROVIDER_LABELS] ?? p : '');
export const sourceDef = (s?: string) => (s ? SOURCES[s as UsageSource] : undefined);
export { modelDisplayName, rowTokens };

export const SLOTS = 7;
/** Categorical slots in fixed order; series past the last slot fold into "Other", never a generated hue. */
export const seriesColor = (i: number) => (i < SLOTS ? `var(--series-${i + 1})` : 'var(--series-other)');

export type Row = PublicRow;
export const seriesKey = (r: Row) => (r.model_id ? `${r.provider ?? ''}\u0001${r.model_id}` : r.provider ?? 'all');

export function seriesName(key: string) {
  if (key === '__other__') return 'Other models';
  if (!key.includes('\u0001')) return providerLabel(key) || 'All usage';
  const [provider, model] = key.split('\u0001');
  return modelDisplayName(model) + (provider ? ` · ${providerLabel(provider)}` : '');
}

/** Color follows the entity: slot by request volume over all rows on the page, so filters never repaint. */
export function colorMap(rows: Row[]): (key: string) => number {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(seriesKey(r), (totals.get(seriesKey(r)) ?? 0) + r.events);
  const order = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return (k) => Math.min(order.indexOf(k) < 0 ? SLOTS : order.indexOf(k), SLOTS);
}

export type Metric = 'output' | 'total' | 'cost' | 'requests';
export const METRIC_LABEL: Record<Metric, string> = { output: 'Output tokens', total: 'Total tokens', cost: 'Estimated cost', requests: 'Requests' };

export function metricOf(r: Row, m: Metric): number {
  if (m === 'requests') return r.events;
  if (m === 'cost') return r.cost_usd ?? 0;
  if (m === 'total') return rowTokens(r);
  return r.output_tokens ?? 0;
}

export function daysFrom(since: string): string[] {
  const out: string[] = [];
  const end = new Date().toISOString().slice(0, 10);
  for (let d = new Date(since + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

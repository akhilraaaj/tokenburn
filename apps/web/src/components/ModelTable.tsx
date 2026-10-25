import { compact, fmt, usd } from '../lib/format.ts';
import { modelDisplayName, providerLabel, rowTokens, seriesColor, seriesKey, sourceDef, type Row } from '../lib/series.ts';

const TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const;

interface Group extends Row { billing: Set<string> }

export function ModelTable({ rows, colorOf, tokens, costs, billing = false }: {
  rows: Row[]; colorOf: (k: string) => number; tokens: boolean; costs: boolean; billing?: boolean;
}) {
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const k = seriesKey(r);
    const g: Group = groups.get(k) ?? {
      provider: r.provider, model_id: r.model_id, usage_source: r.usage_source, events: 0, billing: new Set(),
      input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, cost_usd: null, unpriced_events: 0,
    };
    g.events += r.events;
    if (r.billing_mode) g.billing.add(r.billing_mode);
    for (const f of [...TOKEN_FIELDS, 'cost_usd'] as const) {
      const v = r[f];
      if (v !== null && v !== undefined) g[f] = (g[f] ?? 0) + v;
    }
    g.unpriced_events = (g.unpriced_events ?? 0) + (r.unpriced_events ?? 0);
    groups.set(k, g);
  }
  if (!groups.size) return <p className="text-muted">No usage in this range.</p>;
  const list = [...groups.entries()].sort((a, b) => b[1].events - a[1].events);
  const withModel = !!list[0][1].model_id;
  const withTool = withModel && !!list[0][1].provider;

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>{withModel ? 'Model' : 'Tool'}</th>
            {withTool && <th>Tool</th>}
            <th className="r">Requests</th>
            {tokens && <><th className="r">Input</th><th className="r">Output</th><th className="r">Cache read</th><th className="r">Cache write</th><th className="r">Total</th></>}
            {costs && <th className="r">Est. cost</th>}
            {billing && <th>Billing</th>}
          </tr>
        </thead>
        <tbody>
          {list.map(([k, g]) => {
            const name = withModel ? modelDisplayName(g.model_id!) : providerLabel(g.provider) || 'All';
            return (
              <tr key={k}>
                <td>
                  <i className="swatch mr-2" style={{ background: seriesColor(colorOf(k)) }} />{name}
                  {withModel && name !== g.model_id && <> <code className="text-[0.78rem]">{g.model_id}</code></>}
                  {!withModel && g.usage_source && <> <span className="badge">{sourceDef(g.usage_source)?.label}</span></>}
                </td>
                {withTool && <td>{providerLabel(g.provider)}</td>}
                <td className="r num">{fmt(g.events)}</td>
                {tokens && <>
                  {TOKEN_FIELDS.map((f) => <td key={f} className={`r num ${g[f] === null ? 'text-muted' : ''}`}>{fmt(g[f])}</td>)}
                  <td className="r num">{compact(rowTokens(g))}</td>
                </>}
                {costs && (
                  <td className={`r num ${g.cost_usd === null ? 'text-muted' : ''}`} title={g.unpriced_events ? `${fmt(g.unpriced_events)} requests had no known price` : undefined}>
                    {usd(g.cost_usd)}{g.cost_usd !== null && g.unpriced_events ? '*' : ''}
                  </td>
                )}
                {billing && <td className="text-[0.85rem] text-secondary">{[...g.billing].map((b) => b.replace('_', ' ')).join(', ')}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

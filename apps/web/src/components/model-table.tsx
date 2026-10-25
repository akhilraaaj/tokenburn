import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { compact, fmt, usd } from '@/lib/format.ts';
import { modelDisplayName, providerLabel, rowTokens, seriesColor, seriesKey, sourceDef, type Row } from '@/lib/series.ts';
import { cn } from '@/lib/utils';

const TOKEN_FIELDS = [
  ['input_tokens', 'Input'], ['output_tokens', 'Output'], ['cache_read_tokens', 'Cache read'], ['cache_write_tokens', 'Cache write'],
] as const;

interface Group extends Row { billing: Set<string> }

/** One row per model (or per tool when models aren't shown), sorted by requests. */
export function ModelTable({ rows, colorOf, tokens, costs, billing = false }: {
  rows: Row[];
  colorOf: (k: string) => number;
  tokens: boolean;
  costs: boolean;
  billing?: boolean;
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
    for (const f of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd'] as const) {
      const v = r[f];
      if (v !== null && v !== undefined) g[f] = (g[f] ?? 0) + v;
    }
    g.unpriced_events = (g.unpriced_events ?? 0) + (r.unpriced_events ?? 0);
    groups.set(k, g);
  }
  if (!groups.size) return <p className="py-6 text-center text-sm text-subtle">No usage in this range.</p>;
  const list = [...groups.entries()].sort((a, b) => b[1].events - a[1].events);
  const withModel = !!list[0][1].model_id;
  const withTool = withModel && !!list[0][1].provider;

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{withModel ? 'Model' : 'Tool'}</TableHead>
          {withTool && <TableHead>Tool</TableHead>}
          <TableHead className="text-right">Requests</TableHead>
          {tokens && TOKEN_FIELDS.map(([, l]) => <TableHead key={l} className="text-right">{l}</TableHead>)}
          {tokens && <TableHead className="text-right">Total</TableHead>}
          {costs && <TableHead className="text-right">Est. cost</TableHead>}
          {billing && <TableHead>Billing</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.map(([k, g]) => {
          const name = withModel ? modelDisplayName(g.model_id!) : providerLabel(g.provider) || 'All';
          return (
            <TableRow key={k}>
              <TableCell>
                <div className="flex items-center gap-2.5">
                  <i className="swatch" style={{ background: seriesColor(colorOf(k)) }} />
                  <div className="grid">
                    <span className="font-medium">{name}</span>
                    {withModel && name !== g.model_id && <span className="font-mono text-[0.72rem] text-subtle">{g.model_id}</span>}
                    {!withModel && g.usage_source && <span className="text-xs text-subtle">{sourceDef(g.usage_source)?.label}</span>}
                  </div>
                </div>
              </TableCell>
              {withTool && <TableCell className="text-muted-foreground">{providerLabel(g.provider)}</TableCell>}
              <TableCell className="num text-right">{fmt(g.events)}</TableCell>
              {tokens && TOKEN_FIELDS.map(([f]) => (
                <TableCell key={f} className={cn('num text-right', g[f] === null && 'text-subtle')}>{fmt(g[f])}</TableCell>
              ))}
              {tokens && <TableCell className="num text-right font-medium">{compact(rowTokens(g))}</TableCell>}
              {costs && (
                <TableCell className={cn('num text-right', g.cost_usd === null && 'text-subtle')} title={g.unpriced_events ? `${fmt(g.unpriced_events)} requests had no known price` : undefined}>
                  {usd(g.cost_usd)}{g.cost_usd !== null && g.unpriced_events ? '*' : ''}
                </TableCell>
              )}
              {billing && (
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {[...g.billing].map((b) => <Badge key={b} variant="secondary" className="font-normal">{b.replace('_', ' ')}</Badge>)}
                  </div>
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

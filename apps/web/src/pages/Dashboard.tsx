import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import type { DashboardData, DailyRow } from '../../../../packages/shared/src/index.ts';
import { Chart } from '../components/Chart.tsx';
import { useSession } from '../components/Layout.tsx';
import { ModelTable } from '../components/ModelTable.tsx';
import { Card, HighlightTiles, Loading, Seg, Tile, Tiles } from '../components/ui.tsx';
import { api, ApiError } from '../lib/api.ts';
import { compact, fmt, plural, timeAgo, usd } from '../lib/format.ts';
import { colorMap, METRIC_LABEL, providerLabel, sourceDef, type Metric } from '../lib/series.ts';

type Range = '7' | '30' | '90' | '365';

export function Dashboard() {
  const { user, loading } = useSession();
  const [params, setParams] = useSearchParams();
  const days = (['7', '30', '90', '365'].includes(params.get('days') ?? '') ? params.get('days') : '30') as Range;
  const metric = (['output', 'total', 'requests', 'cost'].includes(params.get('metric') ?? '') ? params.get('metric') : 'output') as Metric;
  const provider = params.get('provider') ?? 'all';
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setError(null);
    api<DashboardData>('GET', `/api/web/dashboard?days=${days}`).then(setData).catch((e: ApiError) => setError(e.message));
  }, [user, days]);

  const set = (k: string, v: string) => setParams((p) => { p.set(k, v); return p; }, { replace: true });
  const colorOf = useMemo(() => colorMap(data?.rows ?? []), [data]);

  if (loading) return <Loading />;
  if (!user) return <Navigate to="/" replace />;
  if (error) return <Card><p className="text-danger">{error}</p></Card>;
  if (!data) return <Loading />;
  if (!data.devices.length && !data.has_data) return <GetStarted origin={data.origin} login={user.github_login} />;

  const providers = [...new Set(data.rows.map((r) => r.provider))];
  const rows = provider === 'all' ? data.rows : data.rows.filter((r) => r.provider === provider);
  const hl = data.highlights;

  return (
    <>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-[1.6rem] font-semibold leading-tight">Your AI coding usage</h1>
        <Seg<Range> items={[['7', '7d'], ['30', '30d'], ['90', '90d'], ['365', '1y']]} value={days} onChange={(v) => set('days', v)} />
      </div>
      <HighlightTiles h={hl} tokens costs streaks windowLabel={`last ${days} days`} />
      {hl.unpricedEvents > 0 && (
        <p className="text-[0.85rem] text-muted">{plural(hl.unpricedEvents, 'request')} {hl.unpricedEvents === 1 ? 'uses a model' : 'use models'} with no known list price
          (for example Cursor's own model names) and {hl.unpricedEvents === 1 ? "isn't" : "aren't"} in the cost estimate.</p>
      )}
      <section className="grid gap-5 grid-cols-[repeat(auto-fit,minmax(300px,1fr))]">
        {providers.length ? providers.map((p) => <ToolCard key={p} provider={p} rows={data.rows.filter((r) => r.provider === p)} sessions={data.sessions[p]} />)
          : <Card><p className="text-muted">No usage in this range.</p></Card>}
      </section>
      <Card>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="font-semibold">{METRIC_LABEL[metric]} per day</h2>
          <div className="flex gap-3 flex-wrap">
            {providers.length > 1 && <Seg items={[['all', 'All'], ...providers.map((p) => [p, providerLabel(p)] as [string, string])]} value={provider} onChange={(v) => set('provider', v)} />}
            <Seg<Metric> items={[['output', 'Output'], ['total', 'Total'], ['requests', 'Requests'], ['cost', 'Cost']]} value={metric} onChange={(v) => set('metric', v)} />
          </div>
        </div>
        <Chart rows={rows} since={data.since} metric={metric} colorOf={colorOf} />
      </Card>
      <Card>
        <h2 className="font-semibold">By model</h2>
        <ModelTable rows={rows} colorOf={colorOf} tokens costs billing />
        <p className="text-[0.85rem] text-muted">Model ids appear exactly as each tool reported them. Estimated cost uses the tool's billed or reported cost
          when it has one, otherwise public API list prices (LiteLLM's price list). It is not what a subscription costs you. * = some requests unpriced.</p>
      </Card>
      <Card>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="font-semibold">Machines</h2>
          <span className="text-[0.85rem] text-muted">Profile is {data.profile_public && user.username ? <Link to={`/@${user.username}`}>public</Link> : 'private'} · <Link to="/settings">settings</Link></span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Device</th><th>Last sync</th><th>Sources</th><th>Version</th></tr></thead>
            <tbody>
              {data.devices.map((d) => {
                const stale = !d.last_sync_at || Date.now() - Date.parse(d.last_sync_at) > 2 * 864e5;
                const found = Object.keys(d.health?.sources ?? {}).map((s) => sourceDef(s)?.label.split(' ')[0] ?? s);
                return (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td title={d.last_sync_at ?? ''}>{stale ? '⚠ ' : ''}{timeAgo(d.last_sync_at)}</td>
                    <td className="text-[0.85rem] text-secondary">{[...new Set(found)].join(', ') || '—'}</td>
                    <td className="text-[0.85rem]">{d.collector_version}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[0.85rem] text-muted">Add another machine: <code>tokenburn setup --api {data.origin}</code></p>
      </Card>
      <footer className="text-[0.8rem] text-muted">Totals come from each tool's own records and use UTC days. Tools count input differently (see each card), so the combined total is indicative.</footer>
    </>
  );
}

function ToolCard({ provider, rows, sessions }: { provider: string; rows: DailyRow[]; sessions?: number }) {
  const src = sourceDef(rows[0]?.usage_source);
  const sum = (f: keyof DailyRow) => rows.reduce<number | null>((a, r) => (r[f] === null ? a : (a ?? 0) + (r[f] as number)), null);
  const t = (label: string, v: number | null, note?: string) =>
    v === null ? <Tile label={label} value="Not available" na note={note} /> : <Tile label={label} value={compact(v)} title={fmt(v)} note={note} />;
  const incomplete = rows.reduce((n, r) => n + r.incomplete_events, 0);
  const billed = sum('billed_cost_usd');
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="font-semibold">{providerLabel(provider)}</h2>
        <span className="badge">{src?.label}</span>
      </div>
      <Tiles>
        {t('Input', sum('input_tokens'), src?.inputNote)}
        {t('Output', sum('output_tokens'), 'incl. reasoning')}
        {t('Cache read', sum('cache_read_tokens'))}
        {t('Cache write', sum('cache_write_tokens'))}
        {t('Requests', sum('events'))}
        {src?.sessions ? t('Sessions', sessions ?? 0) : t('Sessions', null)}
      </Tiles>
      <p className="text-[0.85rem] text-muted">
        Estimated cost {usd(sum('cost_usd'))}{billed ? ` (${usd(billed)} billed)` : ''}
        {incomplete > 0 && ` · ${plural(incomplete, 'request')} didn't report every token field`}
      </p>
    </Card>
  );
}

function GetStarted({ origin, login }: { origin: string; login: string }) {
  return (
    <Card>
      <h1 className="text-[1.6rem] font-semibold leading-tight">Connect your first machine</h1>
      <p className="text-secondary">Usage lives on the computer where you code, so a small collector runs there. It needs Node.js 22.18 or newer.</p>
      <ol className="list-decimal pl-5 grid gap-3.5">
        <li className="grid gap-2"><p>Install and run setup. It signs in with the same GitHub account, previews what it found and asks before uploading anything.</p>
          <pre>{'npm install -g use-tokenburn\ntokenburn setup'}</pre></li>
        <li className="grid gap-2"><p>Using a local or self-hosted server? Point the collector at it:</p><pre>tokenburn setup --api {origin}</pre></li>
        <li><p>Cursor has no usage API: export your usage CSV from cursor.com → Dashboard → Usage, and setup can import new exports from Downloads automatically.</p></li>
      </ol>
      <p className="text-[0.85rem] text-muted">This page switches to your dashboard as soon as the first sync arrives. Signed in as {login}.</p>
    </Card>
  );
}

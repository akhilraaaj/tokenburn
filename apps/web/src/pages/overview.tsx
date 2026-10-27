import { useMemo, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Pills } from '@/components/pills';
import { AreaChart, perDay } from '@/components/profile-widgets';
import { ToolCard } from '@/components/stats';
import { UsageChart } from '@/components/usage-chart';
import { WelcomeScreen } from '@/components/welcome-screen';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useDashboard, type Range } from '@/layouts/app-layout';
import { compact, dayLabel, fmt, plural, usd } from '@/lib/format.ts';
import { colorMap, daysFrom, METRIC_LABEL, providerLabel, rowTokens, type Metric, type Row } from '@/lib/series.ts';

export const RANGES: [Range, string][] = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', '1 year']];

export function PageHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="grid gap-1">
        <h2 className="text-2xl font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted-foreground font-medium">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}</div>
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}

export function Overview() {
  const { data, error, days, setDays } = useDashboard();
  const [metric, setMetric] = useState<Metric>('output');
  const [provider, setProvider] = useState('all');
  const colorOf = useMemo(() => colorMap(data?.rows ?? []), [data]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <DashboardSkeleton />;
  if (!data.devices.length && !data.has_data) return <WelcomeScreen origin={data.origin} />;

  const providers = [...new Set(data.rows.map((r) => r.provider))];
  const rows = provider === 'all' ? data.rows : data.rows.filter((r) => r.provider === provider);
  const hl = data.highlights;

  const best = hl.bestDay;

  return (
    <>
      <PageHeading
        title="Overview"
        description={`Your AI coding usage · last ${days === '365' ? 'year' : `${days} days`} · UTC`}
        action={<Pills label="Range" items={RANGES} value={days} onChange={setDays} />}
      />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <KpiCard
          label="Total tokens" value={compact(hl.totalTokens)} title={fmt(hl.totalTokens)}
          hint={best ? `Best day ${dayLabel(best.day)} · ${compact(best.tokens)}` : 'No usage yet'}
          points={perDay(data.rows, data.since, rowTokens)} color="var(--series-2)" format={(v) => `${fmt(v)} tokens`}
        />
        <KpiCard
          label="Estimated cost" value={hl.costUsd === null ? 'n/a' : usd(hl.costUsd)}
          hint={hl.billedUsd ? `${usd(hl.billedUsd)} billed` : 'API list prices, not a bill'}
          points={perDay(data.rows, data.since, (r) => r.cost_usd ?? 0)} color="var(--series-3)" format={usd}
        />
        <KpiCard
          label="Requests" value={compact(hl.events)} title={fmt(hl.events)}
          hint={plural(Object.values(data.sessions).reduce((a, b) => a + b, 0), 'session')}
          points={perDay(data.rows, data.since, (r) => r.events)} color="var(--series-1)" format={(v) => `${fmt(v)} requests`}
        />
        <KpiCard
          label="Current streak" value={plural(hl.currentStreak, 'day')}
          hint={`Longest ${plural(hl.longestStreak, 'day')} · ${plural(hl.activeDays, 'active day')}`}
          points={streakRuns(data.rows, data.since)} color="var(--series-4)" format={(v) => (v ? `Day ${v} of a streak` : 'No usage')}
        />
      </div>
      {hl.unpricedEvents > 0 && (
        <p className="-mt-3 flex items-center gap-1.5 text-xs text-subtle">
          <Info className="size-3.5" />
          {plural(hl.unpricedEvents, 'request')} {hl.unpricedEvents === 1 ? 'uses a model' : 'use models'} without a known list price and {hl.unpricedEvents === 1 ? "isn't" : "aren't"} in the estimate.
        </p>
      )}
      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <CardTitle>{METRIC_LABEL[metric]} per day</CardTitle>
            <CardDescription>Stacked by model</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {providers.length > 1 && (
              <Pills label="Tool" items={[['all', 'All tools'], ...providers.map((p) => [p, providerLabel(p)] as [string, string])]} value={provider} onChange={setProvider} />
            )}
            <Pills<Metric> label="Metric" items={[['output', 'Output'], ['total', 'Total'], ['requests', 'Requests'], ['cost', 'Cost']]} value={metric} onChange={setMetric} />
          </div>
        </CardHeader>
        <CardContent>
          <UsageChart rows={rows} since={data.since} metric={metric} colorOf={colorOf} />
        </CardContent>
      </Card>
      {providers.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {providers.map((p) => <ToolCard key={p} provider={p} rows={data.rows.filter((r) => r.provider === p)} sessions={data.sessions[p]} />)}
        </div>
      ) : (
        <p className="text-sm text-subtle">No usage in this range.</p>
      )}
      <p className="text-xs text-subtle">
        Totals come from each tool's own records. Tools count input differently (noted on each card), so the combined total is indicative.
        Estimated cost uses billed or tool-reported cost when available, otherwise public API list prices. It isn't what a subscription costs.
      </p>
    </>
  );
}

/** Running streak length per day: climbs on active days, drops to zero on quiet ones. */
export function streakRuns(rows: Row[], since: string) {
  const active = new Set(rows.filter((r) => r.events > 0).map((r) => r.day!));
  let run = 0;
  return daysFrom(since).map((day) => ({ label: dayLabel(day), value: (run = active.has(day) ? run + 1 : 0) }));
}

/** A headline number with its daily sparkline, in the same style as the public profile's trend cards. */
export function KpiCard({ label, value, title, hint, points, color, format }: {
  label: string;
  value: string;
  title?: string;
  hint: string;
  points: { label: string; value: number }[];
  color: string;
  format: (v: number) => string;
}) {
  return (
    <Card className="gap-3 pb-0">
      <CardHeader className="gap-1">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="num text-xl font-semibold sm:text-2xl" title={title}>{value}</CardTitle>
        <span className="truncate text-xs text-subtle font-medium">{hint}</span>
      </CardHeader>
      <CardContent className="mt-auto px-0">
        <AreaChart height={48} points={points} color={color} format={format} />
      </CardContent>
    </Card>
  );
}

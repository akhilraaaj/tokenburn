import { useMemo, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Segmented } from '@/components/segmented';
import { HighlightStats, ToolCard } from '@/components/stats';
import { UsageChart } from '@/components/usage-chart';
import { WelcomeScreen } from '@/components/welcome-screen';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useDashboard, type Range } from '@/layouts/app-layout';
import { plural } from '@/lib/format.ts';
import { colorMap, METRIC_LABEL, providerLabel, type Metric } from '@/lib/series.ts';

export const RANGES: [Range, string][] = [['7', '7d'], ['30', '30d'], ['90', '90d'], ['365', '1y']];

export function PageHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="grid gap-1">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
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

  return (
    <>
      <PageHeading
        title="Your AI coding usage"
        description={`Last ${days === '365' ? 'year' : `${days} days`} · UTC · measured by each tool`}
        action={<Segmented label="Range" items={RANGES} value={days} onChange={setDays} />}
      />
      <HighlightStats h={hl} tokens costs streaks windowLabel={`last ${days} days`} />
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
              <Segmented label="Tool" items={[['all', 'All'], ...providers.map((p) => [p, providerLabel(p)] as [string, string])]} value={provider} onChange={setProvider} />
            )}
            <Segmented<Metric> label="Metric" items={[['output', 'Output'], ['total', 'Total'], ['requests', 'Requests'], ['cost', 'Cost']]} value={metric} onChange={setMetric} />
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

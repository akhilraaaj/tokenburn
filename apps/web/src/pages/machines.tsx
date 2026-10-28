import { AlertTriangle, Laptop } from 'lucide-react';
import { CopyCommand } from '@/components/copy-command';
import { ProviderChip, providerFromSource } from '@/components/tool-logos';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useDashboard } from '@/layouts/app-layout';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/format.ts';
import { sourceDef } from '@/lib/series.ts';
import { DashboardSkeleton, PageHeading } from './overview';

export function Machines() {
  const { data, error } = useDashboard();
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <DashboardSkeleton />;
  return (
    <>
      <PageHeading title="Machines" description="Computers that sync usage to your account" />
      {data.devices.length ? (
        <div className={cn('grid gap-4', data.devices.length > 1 && 'md:grid-cols-2')}>
          {data.devices.map((d) => {
            const stale = !d.last_sync_at || Date.now() - Date.parse(d.last_sync_at) > 2 * 864e5;
            const found = [...new Set(
              Object.keys(d.health?.sources ?? {}).map((s) => providerFromSource(s) ?? sourceDef(s)?.label ?? s),
            )];
            return (
              <Card key={d.id} className="gap-4">
                <CardHeader className="flex items-start gap-3">
                  <span className="flex size-10 flex-none items-center justify-center rounded-xl border bg-surface-2/60"><Laptop className="size-5 text-muted-foreground" /></span>
                  <div className="grid min-w-0 flex-1 gap-1">
                    <CardTitle className="truncate">{d.name}</CardTitle>
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground" title={d.last_sync_at ?? ''}>
                      {stale
                        ? <AlertTriangle className="size-3.5 text-warn-ink" />
                        : <span className="size-1.5 rounded-full" style={{ background: 'var(--series-3)' }} />}
                      {d.last_sync_at ? `Synced ${timeAgo(d.last_sync_at)}` : 'Never synced'}
                    </span>
                  </div>
                  {d.collector_version && <Badge variant="outline" className="num font-normal text-muted-foreground">v{d.collector_version}</Badge>}
                </CardHeader>
                <CardContent className="grid gap-2 border-t pt-4">
                  <span className="text-xs text-subtle">Sources found</span>
                  <div className="flex flex-wrap gap-1.5">
                    {found.length
                      ? found.map((f) => <ProviderChip key={f} provider={f} />)
                      : <span className="text-sm text-subtle">None yet</span>}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card><CardContent className="py-10 text-center text-sm text-subtle">No machines yet</CardContent></Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Add a machine</CardTitle>
          <CardDescription>Run setup on any computer where you code. It joins this account when you sign in with the same GitHub user.</CardDescription>
        </CardHeader>
        <CardContent>
          <CopyCommand command={data.origin.startsWith('http://localhost') ? `tokenburn setup --api ${data.origin}` : 'npm install -g use-tokenburn && tokenburn setup'} />
        </CardContent>
      </Card>
      <p className="text-xs text-subtle">Automatic sync runs every 30 minutes. A warning appears when a machine hasn't synced for 2 days. Disconnect machines in Settings.</p>
    </>
  );
}

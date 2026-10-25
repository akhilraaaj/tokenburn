import { AlertTriangle } from 'lucide-react';
import { CopyCommand } from '@/components/copy-command';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDashboard } from '@/layouts/app-layout';
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
      <Card className="py-0">
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Device</TableHead>
                <TableHead>Last sync</TableHead>
                <TableHead>Sources found</TableHead>
                <TableHead className="text-right">Version</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.devices.length ? data.devices.map((d) => {
                const stale = !d.last_sync_at || Date.now() - Date.parse(d.last_sync_at) > 2 * 864e5;
                const found = [...new Set(Object.keys(d.health?.sources ?? {}).map((s) => sourceDef(s)?.label.split(' ')[0] ?? s))];
                return (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.name}</TableCell>
                    <TableCell title={d.last_sync_at ?? ''}>
                      <span className="inline-flex items-center gap-1.5">
                        {stale && <AlertTriangle className="size-3.5 text-warn-ink" />}
                        {timeAgo(d.last_sync_at)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {found.length ? found.map((f) => <Badge key={f} variant="secondary" className="font-normal">{f}</Badge>) : <span className="text-subtle">—</span>}
                      </div>
                    </TableCell>
                    <TableCell className="num text-right text-muted-foreground">{d.collector_version ?? '—'}</TableCell>
                  </TableRow>
                );
              }) : (
                <TableRow><TableCell colSpan={4} className="py-8 text-center text-subtle">No machines yet</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
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

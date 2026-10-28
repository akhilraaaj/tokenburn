import { AreaChart } from '@/components/profile-widgets';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { dayLabel } from '@/lib/format.ts';
import { daysFrom, type Row } from '@/lib/series.ts';

// Shared by the dashboard's Overview and the landing page's dashboard preview. It lives here, not in the
// Overview page, so the landing page doesn't pull in the (lazy-loaded) dashboard layout with it.

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

import type { ReactNode } from 'react';
import type { DailyRow, Highlights } from '../../../../packages/shared/src/index.ts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { compact, dayLabel, fmt, plural, usd } from '@/lib/format.ts';
import { providerLabel, sourceDef } from '@/lib/series.ts';
import { cn } from '@/lib/utils';

export function Stat({ label, value, hint, muted = false, title }: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  muted?: boolean;
  title?: string;
}) {
  return (
    <Card size="sm" className="gap-1.5">
      <CardHeader className="gap-0">
        <CardDescription className="text-xs">{label}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-0.5">
        <span title={title} className={cn('num font-semibold', muted ? 'text-base text-subtle' : 'text-2xl')}>{value}</span>
        {hint && <span className="text-xs text-subtle">{hint}</span>}
      </CardContent>
    </Card>
  );
}

export const StatGrid = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn('grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5', className)}>{children}</div>
);

type PublicHighlights = Omit<Partial<Highlights>, 'bestDay'> & { bestDay?: { day: string; tokens?: number } | null };

/** Highlight cards; each group appears only when its flag is on (the public profile passes the owner's choices). */
export function HighlightStats({ h, tokens, costs, streaks, windowLabel, extra = [] }: {
  h: PublicHighlights;
  tokens: boolean;
  costs: boolean;
  streaks: boolean;
  windowLabel: string;
  /** More cards for the same grid (the public profile's session counts). */
  extra?: ReactNode[];
}) {
  const items: ReactNode[] = [];
  if (tokens && h.totalTokens !== undefined) {
    items.push(<Stat key="t" label="Total tokens" value={compact(h.totalTokens)} title={fmt(h.totalTokens)} hint={windowLabel} />);
  }
  if (costs && h.costUsd !== undefined) {
    items.push(h.costUsd === null
      ? <Stat key="c" label="Estimated cost" value="Not available" muted hint="no priced models" />
      : <Stat key="c" label="Estimated cost" value={usd(h.costUsd)} hint={h.billedUsd ? `${usd(h.billedUsd)} billed` : 'API list prices, not a bill'} />);
  }
  if (streaks && h.currentStreak !== undefined) {
    items.push(<Stat key="cs" label="Current streak" value={plural(h.currentStreak, 'day')} hint="consecutive days" />);
    items.push(<Stat key="ls" label="Longest streak" value={plural(h.longestStreak ?? 0, 'day')} hint={`${plural(h.activeDays ?? 0, 'active day')}`} />);
    if (h.bestDay) {
      items.push(<Stat key="bd" label="Best day" value={dayLabel(h.bestDay.day)} hint={h.bestDay.tokens !== undefined ? `${compact(h.bestDay.tokens)} tokens` : 'most active day'} />);
    }
  }
  items.push(...extra);
  // Fill whole rows on wide screens instead of leaving one card alone on the last row.
  const wide = items.length === 6 ? 'lg:grid-cols-6' : items.length === 4 ? 'lg:grid-cols-4' : undefined;
  return items.length ? <StatGrid className={wide}>{items}</StatGrid> : null;
}

/** Per-tool summary. Metrics a tool can't report show "n/a", distinct from zero. */
export function ToolCard({ provider, rows, sessions }: { provider: string; rows: DailyRow[]; sessions?: number }) {
  const src = sourceDef(rows[0]?.usage_source);
  const sum = (f: keyof DailyRow) => rows.reduce<number | null>((a, r) => (r[f] === null ? a : (a ?? 0) + (r[f] as number)), null);
  const metrics: [string, number | null, string?][] = [
    ['Input', sum('input_tokens'), src?.inputNote],
    ['Output', sum('output_tokens'), 'incl. reasoning'],
    ['Cache read', sum('cache_read_tokens')],
    ['Cache write', sum('cache_write_tokens')],
    ['Requests', sum('events')],
    ['Sessions', src?.sessions ? sessions ?? 0 : null],
  ];
  const incomplete = rows.reduce((n, r) => n + r.incomplete_events, 0);
  const billed = sum('billed_cost_usd');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>{providerLabel(provider)}</span>
          <Badge variant="outline" className="font-normal text-muted-foreground">{src?.label}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          {metrics.map(([label, v, note]) => (
            <div key={label} className="grid gap-0.5">
              <dt className="text-xs text-subtle">{label}</dt>
              <dd className={cn('num text-lg font-semibold', v === null && 'text-sm font-normal text-subtle')} title={v === null ? undefined : fmt(v)}>
                {v === null ? 'n/a' : compact(v)}
              </dd>
              {note && <span className="text-[0.7rem] leading-tight text-subtle">{note}</span>}
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          Estimated cost <span className="num font-medium text-foreground">{usd(sum('cost_usd'))}</span>
          {billed ? ` · ${usd(billed)} billed` : ''}
          {incomplete > 0 && ` · ${plural(incomplete, 'request')} without full token counts`}
        </p>
      </CardContent>
    </Card>
  );
}

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { PublicProfile } from '../../../../packages/shared/src/index.ts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { dayLabel, fmt, usd } from '@/lib/format.ts';
import { Pills } from '@/components/pills';
import { UsageChart } from '@/components/usage-chart';
import { daysFrom, METRIC_LABEL, modelDisplayName, providerLabel, rowTokens, seriesColor, seriesKey, type Metric, type Row } from '@/lib/series.ts';
import { cn } from '@/lib/utils';

/** Tokens when the owner shares them, otherwise requests (always present). */
const valueOf = (r: Row, tokens: boolean) => (tokens ? rowTokens(r) : r.events);
const unitOf = (tokens: boolean) => (tokens ? 'tokens' : 'requests');

/** Sequential ramp: the brand hue stepped toward the card surface; level 0 is the empty cell. */
const LEVELS = [
  'var(--tb-surface-2)',
  ...[28, 50, 75, 100].map((p) => `color-mix(in oklab, var(--tb-brand) ${p}%, var(--tb-surface-1))`),
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Widget({ title, description, action, children }: { title: string; description: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="h-full">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1.5">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        {action}
      </CardHeader>
      <CardContent className="mt-auto">{children}</CardContent>
    </Card>
  );
}

/** Small hover card positioned inside a relative wrapper, same look as the daily chart's tooltip. */
function Tip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute z-10 grid gap-0.5 rounded-lg border bg-popover px-3 py-2 text-xs whitespace-nowrap text-popover-foreground shadow-md"
      style={{ left: Math.max(0, Math.min(x + 12, width - 170)), top: Math.max(0, y - 56) }}
    >
      {children}
    </div>
  );
}

function useHover<T>() {
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ item: T; x: number; y: number } | null>(null);
  const track = (item: T) => (e: React.MouseEvent) => {
    const box = wrap.current!.getBoundingClientRect();
    setHover({ item, x: e.clientX - box.left, y: e.clientY - box.top });
  };
  return { wrap, hover, track, clear: () => setHover(null), width: wrap.current?.clientWidth ?? 0 };
}

/** Target square size and gap for the contribution grid; the number of weeks shown follows the card's width. */
const CELL = 14, CELL_GAP = 3, LABEL_W = 28;

/**
 * GitHub-style grid: one column per week, Sunday on top, shaded by quartile of the active days. It always spans
 * the card's full width at a steady square size by showing as many recent weeks as fit (up to the data's range).
 */
export function ContributionGraph({ days, since, tokens }: {
  days: { day: string; value: number }[];
  /** The earliest day the data covers. */
  since: string;
  tokens: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setFit(Math.floor((e.contentRect.width - LABEL_W + CELL_GAP) / (CELL + CELL_GAP))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const maxWeeks = Math.ceil((daysFrom(since).length + 6) / 7);
  const weeks = Math.max(4, Math.min(fit || 26, maxWeeks));
  // Whole weeks ending with the current one, so the newest column is this week.
  const today = new Date();
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - today.getUTCDay() - (weeks - 1) * 7))
    .toISOString().slice(0, 10);

  const m = useMemo(() => {
    const totals = new Map<string, number>();
    for (const d of days) if (d.day >= from) totals.set(d.day, (totals.get(d.day) ?? 0) + d.value);
    const all = daysFrom(from);
    const active = [...totals.values()].filter((v) => v > 0).sort((a, b) => a - b);
    const q = [0.25, 0.5, 0.75].map((p) => active[Math.floor(p * (active.length - 1))] ?? 0);
    const level = (v: number) => (v <= 0 ? 0 : v <= q[0] ? 1 : v <= q[1] ? 2 : v <= q[2] ? 3 : 4);
    const grid = new Map<string, { day: string; value: number; level: number }>();
    all.forEach((day, i) => {
      const value = day < since ? -1 : totals.get(day) ?? 0;
      grid.set(`${Math.floor(i / 7)}:${i % 7}`, { day, value, level: level(value) });
    });
    // Label the first week that contains the 1st of a month.
    const labels = new Map<number, string>();
    all.forEach((day, i) => {
      if (day.slice(8) === '01') labels.set(Math.floor(i / 7), new Date(day + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }));
    });
    return { grid, labels, activeDays: active.length };
  }, [days, from, since]);
  type Cell = NonNullable<ReturnType<typeof m.grid.get>>;
  const { wrap, hover, track, clear, width } = useHover<Cell>();
  const months = Math.round(weeks / 4.35);
  const period = weeks >= 52 ? 'in the past year' : `in the last ${months} month${months === 1 ? '' : 's'}`;

  return (
    <Widget title="Contributions" description={`${m.activeDays} active days ${period}`}>
      <div ref={box} className="grid gap-3">
        <div ref={wrap} className="relative" onMouseLeave={clear} role="img" aria-label={`Daily ${unitOf(tokens)}, ${period}`}>
          <div
            className="grid"
            // When the data covers fewer weeks than fit, keep squares near their usual size instead of stretching.
            style={{ gridTemplateColumns: `${LABEL_W}px repeat(${weeks}, minmax(0, 1fr))`, gap: CELL_GAP, maxWidth: fit > weeks ? LABEL_W + weeks * 21 : undefined }}
          >
            <span />
            {Array.from({ length: weeks }, (_, col) => (
              <span key={col} className="h-4 text-[0.7rem] leading-none whitespace-nowrap text-subtle">{m.labels.get(col) ?? ''}</span>
            ))}
            {Array.from({ length: 7 }, (_, row) => [
              <span key={`l${row}`} className="self-center text-[0.7rem] leading-none text-subtle">{row % 2 ? WEEKDAYS[row] : ''}</span>,
              ...Array.from({ length: weeks }, (_, col) => {
                const c = m.grid.get(`${col}:${row}`);
                // Days after today and before the data starts stay blank.
                return c && c.value >= 0 ? (
                  <div
                    key={col}
                    className={cn('aspect-square rounded-[3px]', hover?.item.day === c.day && 'ring-1 ring-foreground')}
                    style={{ background: LEVELS[c.level] }}
                    onMouseMove={track(c)}
                  />
                ) : <div key={col} />;
              }),
            ])}
          </div>
          {hover && (
            <Tip x={hover.x} y={hover.y} width={width}>
              <span className="font-medium">{dayLabel(hover.item.day)}, {hover.item.day.slice(0, 4)} <span className="font-normal text-subtle">· UTC</span></span>
              <span className="text-muted-foreground">{hover.item.value ? `${fmt(hover.item.value)} ${unitOf(tokens)}` : 'No usage'}</span>
            </Tip>
          )}
        </div>
        <div className="flex items-center justify-end gap-1 text-xs text-subtle">
          Less{LEVELS.map((c) => <span key={c} className="size-2.5 rounded-[2px]" style={{ background: c }} />)}More
        </div>
      </div>
    </Widget>
  );
}

/** One decimal for the headline number, like "927.4M". */
function headline(n: number): string {
  const a = Math.abs(n);
  const f = (v: number, u: string) => `${v.toFixed(1).replace(/\.0$/, '')}${u}`;
  return a >= 1e9 ? f(n / 1e9, 'B') : a >= 1e6 ? f(n / 1e6, 'M') : a >= 1e3 ? f(n / 1e3, 'K') : fmt(Math.round(n));
}

/**
 * A single-series area chart: 2px line over a flat tint, a hairline baseline, and a crosshair + tooltip on hover.
 * Stretches to its container's width at a fixed height.
 */
export function AreaChart({ points, color, format, height = 140, xLabels, mark }: {
  points: { label: string; value: number }[];
  color: string;
  format: (v: number) => string;
  height?: number;
  /** One point called out with a dot and a short label (e.g. the best day). */
  mark?: { index: number; label: string };
  /** Labels under the chart, spread evenly from first to last point; none for a bare sparkline. */
  xLabels?: string[];
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 600, PAD = 6;
  const n = points.length;
  const max = Math.max(1e-9, ...points.map((p) => p.value));
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * W : W / 2);
  const y = (v: number) => PAD + (1 - v / max) * (height - PAD);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join('');
  const pct = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const h = hover === null ? null : points[hover];

  return (
    <div className="grid gap-3">
      <div
        ref={wrap}
        className="relative"
        style={{ height }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = wrap.current!.getBoundingClientRect();
          setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - box.left) / box.width) * (n - 1)))));
        }}
      >
        <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" role="img" aria-hidden>
          <path d={`${line}L${x(n - 1)},${height}L${x(0)},${height}Z`} fill={`color-mix(in oklab, ${color} 16%, transparent)`} />
          <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={W} y1={height - 0.5} y2={height - 0.5} stroke="var(--tb-grid)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>
        {mark && mark.index >= 0 && hover === null && (
          <>
            <div
              className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card"
              style={{ left: `${pct(mark.index)}%`, top: y(points[mark.index].value), background: color }}
            />
            <span
              className="pointer-events-none absolute text-xs whitespace-nowrap text-muted-foreground"
              style={{ top: Math.max(0, y(points[mark.index].value) - 9), ...(pct(mark.index) > 60 ? { right: `${100 - pct(mark.index)}%`, marginRight: 12 } : { left: `${pct(mark.index)}%`, marginLeft: 12 }) }}
            >
              {mark.label}
            </span>
          </>
        )}
        {h && hover !== null && (
          <>
            <div className="pointer-events-none absolute inset-y-0 w-px bg-foreground/20" style={{ left: `${pct(hover)}%` }} />
            <div
              className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card"
              style={{ left: `${pct(hover)}%`, top: y(h.value), background: color }}
            />
            <div
              className="pointer-events-none absolute z-10 grid gap-0.5 rounded-lg border bg-popover px-3 py-2 text-xs whitespace-nowrap text-popover-foreground shadow-md"
              style={{ top: 0, ...(pct(hover) > 60 ? { right: `${100 - pct(hover)}%`, marginRight: 10 } : { left: `${pct(hover)}%`, marginLeft: 10 }) }}
            >
              <span className="font-medium">{h.label}</span>
              <span className="num text-muted-foreground">{format(h.value)}</span>
            </div>
          </>
        )}
      </div>
      {xLabels && xLabels.length > 0 && (
        <div className="flex justify-between gap-2 text-xs text-subtle">
          {xLabels.map((l, i) => <span key={i}>{l}</span>)}
        </div>
      )}
    </div>
  );
}

/** A stat with its trend: small label, big number, then the chart (the profile's take on a stat card). */
export function TrendCard({ label, value, action, footer, children }: {
  label: string;
  value: string;
  action?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card className="h-full gap-4">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <CardDescription>{label}</CardDescription>
          <CardTitle className="num text-3xl font-normal">{value}</CardTitle>
        </div>
        {action}
      </CardHeader>
      {(children || footer) && (
        <CardContent className="mt-auto grid gap-4">
          {children}
          {footer && <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">{footer}</div>}
        </CardContent>
      )}
    </Card>
  );
}

/** Daily totals of `pick` for every day from `since` to today (zeros on quiet days). */
export function perDay(rows: Row[], since: string, pick: (r: Row) => number) {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.day!, (totals.get(r.day!) ?? 0) + pick(r));
  return daysFrom(since).map((day) => ({ label: dayLabel(day), value: totals.get(day) ?? 0 }));
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Total per weekday over the window, Monday first, drawn like the trend cards. */
export function WeekdayChart({ rows, tokens }: { rows: Row[]; tokens: boolean }) {
  const totals = useMemo(() => {
    const t = Array(7).fill(0) as number[];
    for (const r of rows) t[new Date(r.day + 'T00:00:00Z').getUTCDay()] += valueOf(r, tokens);
    return t;
  }, [rows, tokens]);
  const order = [1, 2, 3, 4, 5, 6, 0];
  const busiest = totals.indexOf(Math.max(...totals));
  return (
    <TrendCard label="By day of week" value={totals[busiest] ? `${WEEKDAY_NAMES[busiest]}s` : 'No usage yet'}>
      <AreaChart
        points={order.map((d) => ({ label: `${WEEKDAY_NAMES[d]}s`, value: totals[d] }))}
        color="var(--series-2)"
        format={(v) => `${fmt(Math.round(v))} ${unitOf(tokens)}`}
        xLabels={order.map((d) => WEEKDAYS[d])}
      />
    </TrendCard>
  );
}

type ActivityMetric = 'tokens' | 'requests' | 'cost';

/**
 * Usage over time in one card: switch between tokens, requests and cost (whichever the owner shares). The best day
 * is called out on the line. Without the daily trend it shows the totals alone.
 */
export function ActivityCard({ profile, since }: { profile: PublicProfile; since: string }) {
  const h = profile.highlights ?? {};
  const daily = profile.first_day ? profile.daily : undefined;
  const hasCost = profile.shows.costs && h.costUsd !== undefined && h.costUsd !== null;
  const options = ([
    profile.shows.tokens && h.totalTokens !== undefined && ['tokens', 'Tokens'],
    daily && ['requests', 'Requests'],
    hasCost && ['cost', 'Cost'],
  ].filter(Boolean)) as [ActivityMetric, string][];
  const [metric, setMetric] = useState<ActivityMetric | null>(null);
  const active = metric && options.some(([v]) => v === metric) ? metric : options[0]?.[0];
  if (!active) return null;

  const pick = (r: Row) => (active === 'tokens' ? rowTokens(r) : active === 'cost' ? r.cost_usd ?? 0 : r.events);
  const points = daily ? perDay(daily, since, pick) : undefined;
  const value = active === 'tokens' ? `${headline(h.totalTokens!)} tokens`
    : active === 'cost' ? usd(h.costUsd!)
    : `${headline(daily!.reduce((a, r) => a + r.events, 0))} requests`;
  const format = active === 'cost' ? usd : (v: number) => `${fmt(v)} ${active}`;
  const top = points ? points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0) : -1;
  const color = active === 'tokens' ? 'var(--series-2)' : active === 'cost' ? 'var(--series-3)' : 'var(--series-1)';
  const best = h.bestDay;

  return (
    <TrendCard
      label={active === 'cost' ? 'Estimated cost · last 90 days · API list prices, not a bill' : 'Last 90 days'}
      value={value}
      action={options.length > 1 && <Pills items={options} value={active} onChange={setMetric} label="Metric" />}
      footer={!points && best && <span>Best day {dayLabel(best.day)}{best.tokens !== undefined && ` · ${headline(best.tokens)} tokens`}</span>}
    >
      {points && (
        <AreaChart
          height={180}
          points={points}
          color={color}
          format={format}
          xLabels={[dayLabel(since), 'Today']}
          mark={top >= 0 && points[top].value > 0 ? { index: top, label: `Best day · ${points[top].label}` } : undefined}
        />
      )}
    </TrendCard>
  );
}

/**
 * Current streak, longest streak and active days in one card. The chart counts up each consecutive active day and
 * drops to zero on a quiet one, so every streak in the window reads as a ramp.
 */
export function StreakCard({ profile, since }: { profile: PublicProfile; since: string }) {
  const h = profile.highlights ?? {};
  const daily = profile.first_day ? profile.daily : undefined;
  const points = useMemo(() => {
    if (!daily) return undefined;
    const active = new Set(daily.filter((r) => r.events > 0).map((r) => r.day!));
    let run = 0;
    return daysFrom(since).map((day) => ({ label: dayLabel(day), value: (run = active.has(day) ? run + 1 : 0) }));
  }, [daily, since]);
  const current = h.currentStreak ?? 0;
  const top = points ? points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0) : -1;
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  return (
    <TrendCard
      label="Current streak"
      value={current ? days(current) : 'No streak'}
    >
      {points && (
        <AreaChart
          height={110}
          points={points}
          color="var(--series-4)"
          format={(v) => (v ? `Day ${v} of a streak` : 'No usage')}
          xLabels={[dayLabel(since), 'Today']}
          mark={top >= 0 && points[top].value > 1 ? { index: top, label: `${points[top].value}-day run` } : undefined}
        />
      )}
    </TrendCard>
  );
}

type ModelMetric = 'tokens' | 'requests' | 'cost';

/** Rows visible before "Show more". */
const MODELS_SHOWN = 5;

interface ModelGroup {
  key: string;
  provider?: string;
  model_id?: string;
  events: number;
  input: number | null;
  output: number | null;
  tokens: number | null;
  cost: number | null;
}

const add = (a: number | null, v: number | null | undefined) => (v === null || v === undefined ? a : (a ?? 0) + v);

/**
 * Models (or tools) ranked by the chosen metric with their share. A row opens to the essentials: requests,
 * input, output, cost and, when the daily trend is public, that model's own trend.
 */
export function ModelBreakdown({ rows, daily, since, colorOf, tokens, costs }: {
  rows: Row[];
  daily?: Row[];
  since: string;
  colorOf: (k: string) => number;
  tokens: boolean;
  costs: boolean;
}) {
  const options = ([tokens && ['tokens', 'Tokens'], ['requests', 'Requests'], costs && ['cost', 'Cost']].filter(Boolean)) as [ModelMetric, string][];
  const [metric, setMetric] = useState<ModelMetric>(tokens ? 'tokens' : 'requests');
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  const groups = useMemo(() => {
    const m = new Map<string, ModelGroup>();
    for (const r of rows) {
      const key = seriesKey(r);
      const g = m.get(key) ?? { key, provider: r.provider, model_id: r.model_id, events: 0, input: null, output: null, tokens: null, cost: null };
      g.events += r.events;
      g.input = add(g.input, r.input_tokens);
      g.output = add(g.output, r.output_tokens);
      g.tokens = r.output_tokens === undefined ? g.tokens : add(g.tokens, rowTokens(r));
      g.cost = add(g.cost, r.cost_usd);
      m.set(key, g);
    }
    return [...m.values()];
  }, [rows]);
  const valueOfGroup = (g: ModelGroup) => (metric === 'tokens' ? g.tokens ?? 0 : metric === 'cost' ? g.cost ?? 0 : g.events);
  const show = (v: number) => (metric === 'cost' ? usd(v) : metric === 'tokens' ? headline(v) : fmt(v));
  const list = [...groups].sort((a, b) => valueOfGroup(b) - valueOfGroup(a));
  const total = list.reduce((a, g) => a + valueOfGroup(g), 0) || 1;
  const withModel = !!list[0]?.model_id;

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <CardTitle>{withModel ? 'Models' : 'Tools'}</CardTitle>
          <CardDescription>Last 90 days · select one for details</CardDescription>
        </div>
        {options.length > 1 && <Pills items={options} value={metric} onChange={setMetric} label="Sort models by" lead="Sort by" />}
      </CardHeader>
      <CardContent className="grid">
        {(all ? list : list.slice(0, MODELS_SHOWN)).map((g) => {
          const isOpen = open === g.key;
          const v = valueOfGroup(g);
          const color = seriesColor(colorOf(g.key));
          const name = g.model_id ? modelDisplayName(g.model_id) : providerLabel(g.provider) || 'All usage';
          const tool = g.model_id && g.provider ? providerLabel(g.provider) : null;
          const own = daily?.filter((r) => seriesKey(r) === g.key) ?? [];
          const facts: [string, string][] = [
            ['Requests', fmt(g.events)],
            ...(g.input !== null ? [['Input tokens', fmt(g.input)] as [string, string]] : []),
            ...(g.output !== null ? [['Output tokens', fmt(g.output)] as [string, string]] : []),
            ...(g.cost !== null ? [['Est. cost', usd(g.cost)] as [string, string]] : []),
            ...(own.length ? [['Active days', fmt(new Set(own.map((r) => r.day)).size)] as [string, string]] : []),
          ];
          return (
            <div key={g.key} className="border-t first:border-t-0">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : g.key)}
                className="-mx-2 grid w-[calc(100%+1rem)] gap-2 rounded-lg px-2 py-3 text-left transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <i className="swatch" style={{ background: color }} />
                    <span className="truncate text-sm font-medium">{name}</span>
                    {tool && <span className="hidden truncate text-xs text-subtle font-medium sm:inline">{tool}</span>}
                  </span>
                  <span className="flex flex-none items-center gap-2">
                    <span className="num text-sm">{show(v)}</span>
                    <span className="num w-10 text-right text-xs text-subtle">{v > 0 && v / total < 0.01 ? '<1' : Math.round((v / total) * 100)}%</span>
                    <ChevronDown className={cn('size-4 text-subtle transition-transform', isOpen && 'rotate-180')} />
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.max((v / total) * 100, 0.5)}%`, background: color }} />
                </div>
              </button>
              {isOpen && (
                <div className="grid gap-4 pt-1 pb-4 animate-in fade-in slide-in-from-top-1">
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
                    {facts.map(([l, val]) => (
                      <div key={l} className="grid gap-0.5">
                        <dt className="text-xs text-subtle">{l}</dt>
                        <dd className="num text-sm font-medium">{val}</dd>
                      </div>
                    ))}
                  </dl>
                  {own.length > 0 && (
                    <AreaChart
                      height={72}
                      points={perDay(own, since, (r) => valueOf(r, tokens))}
                      color={color}
                      format={(x) => `${fmt(x)} ${unitOf(tokens)}`}
                      xLabels={[dayLabel(since), 'Today']}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
        {list.length > MODELS_SHOWN && (
          <button
            type="button"
            onClick={() => setAll(!all)}
            className="inline-flex items-center justify-center gap-1.5 border-t pt-3 pb-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            {all ? 'Show less' : `Show ${list.length - MODELS_SHOWN} more`}
            <ChevronDown className={cn('size-4 transition-transform', all && 'rotate-180')} />
          </button>
        )}
      </CardContent>
    </Card>
  );
}

const DAY_RANGES = [['7d', 7], ['30d', 30], ['90d', 90]] as const;
type DayRange = (typeof DAY_RANGES)[number][0];

/**
 * The per-day bar chart split by model. Defaults to 30 days so bars stay wide enough to read; 90 days is a click
 * away. Ranges longer than the data aren't offered.
 */
export function DailyBarsCard({ rows, since, metric, colorOf }: { rows: Row[]; since: string; metric: Metric; colorOf: (k: string) => number }) {
  const available = daysFrom(since).length;
  const options = DAY_RANGES.filter(([, n], i) => i === 0 || n <= available + 29);
  const [range, setRange] = useState<DayRange>('30d');
  const [, n] = options.find(([k]) => k === range) ?? options[options.length - 1];
  const cut = new Date(Date.now() - (n - 1) * 864e5).toISOString().slice(0, 10);
  const from = cut < since ? since : cut;
  return (
    <Widget
      title={`${METRIC_LABEL[metric]} per day`}
      description={`Since ${dayLabel(from)} · UTC days`}
      action={options.length > 1 && (
        <Pills items={options.map(([k, n]) => [k, `${n} days`] as [DayRange, string])} value={range} onChange={setRange} label="Range" />
      )}
    >
      <UsageChart rows={rows.filter((r) => r.day! >= from)} since={from} metric={metric} colorOf={colorOf} />
    </Widget>
  );
}

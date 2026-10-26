import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { compact, dayLabel, fmt, usd } from '@/lib/format.ts';
import { daysFrom, METRIC_LABEL, metricOf, seriesColor, seriesKey, seriesName, SLOTS, type Metric, type Row } from '@/lib/series.ts';

const PAD_L = 46, PAD_R = 4, PAD_T = 8, PAD_B = 24;

/**
 * Stacked daily columns by model. Marks ≤24px wide, 2px surface gap between segments, 4px rounded top,
 * hairline grid. Series past the last categorical slot fold into "Other" (never a generated hue).
 */
export function UsageChart({ rows, since, metric, colorOf, height: H = 240 }: {
  rows: Row[];
  since: string;
  metric: Metric;
  colorOf: (k: string) => number;
  /** Plot height in px; the width always follows the container, so labels render at their real size. */
  height?: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const [W, setW] = useState(900);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => { if (el.clientWidth) setW(el.clientWidth); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const m = useMemo(() => {
    const days = daysFrom(since);
    const group = (k: string) => (colorOf(k) >= SLOTS ? '__other__' : k);
    const byDay = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const g = group(seriesKey(r));
      const d = byDay.get(r.day!) ?? new Map<string, number>();
      d.set(g, (d.get(g) ?? 0) + metricOf(r, metric));
      byDay.set(r.day!, d);
    }
    const order = (g: string) => (g === '__other__' ? 99 : colorOf(g));
    const groups = [...new Set(rows.map((r) => group(seriesKey(r))))].sort((a, b) => order(a) - order(b));
    const max = Math.max(metric === 'cost' ? 0.01 : 1, ...days.map((d) => [...(byDay.get(d)?.values() ?? [])].reduce((a, b) => a + b, 0)));
    const p = Math.pow(10, Math.floor(Math.log10(max / 4)));
    const n = max / 4 / p;
    const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
    return { days, byDay, groups, step, yMax: Math.ceil(max / step) * step };
  }, [rows, since, metric, colorOf]);

  const color = (g: string) => (g === '__other__' ? seriesColor(SLOTS) : seriesColor(colorOf(g)));
  const show = (v: number) => (metric === 'cost' ? usd(v) : fmt(Math.round(v)));
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;
  const band = innerW / Math.max(m.days.length, 1);
  const barW = Math.min(24, Math.max(2, band * 0.66));
  const y = (v: number) => PAD_T + innerH - (v / m.yMax) * innerH;
  const ticks: number[] = [];
  for (let i = 0; i * m.step <= m.yMax + m.step / 1e6 && i < 20; i++) ticks.push(i * m.step);
  // Roughly one date label per 80px, so they never crowd on narrow screens.
  const every = Math.ceil(m.days.length / Math.max(2, Math.floor(innerW / 80)));
  const hovered = hover ? m.days[hover.i] : null;
  const hoveredVals = hovered ? m.byDay.get(hovered) : undefined;
  const hoveredGroups = hoveredVals ? m.groups.filter((g) => hoveredVals.has(g)) : [];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {m.groups.length ? m.groups.map((g) => (
          <span key={g} className="inline-flex items-center gap-1.5"><i className="swatch" style={{ background: color(g) }} />{seriesName(g)}</span>
        )) : <span className="text-subtle">No usage in this range</span>}
      </div>
      <div ref={wrap} className="relative" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`${METRIC_LABEL[metric]} per day by model`}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} stroke="var(--tb-grid)" strokeWidth={1} />
              <text x={PAD_L - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill="var(--tb-text-3)">{metric === 'cost' ? `$${compact(v)}` : compact(v)}</text>
            </g>
          ))}
          {m.days.map((d, i) => {
            const vals = m.byDay.get(d);
            const x = PAD_L + band * i + (band - barW) / 2;
            const segs = vals ? m.groups.filter((g) => (vals.get(g) ?? 0) > 0) : [];
            let acc = 0;
            return (
              <g key={d}>
                {i % every === 0 && <text x={PAD_L + band * i + band / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--tb-text-3)">{dayLabel(d)}</text>}
                {segs.map((g, si) => {
                  const v = vals!.get(g)!;
                  const top = y(acc + v), bottom = y(acc);
                  acc += v;
                  const h = Math.max(0, bottom - top - (si > 0 ? 2 : 0));
                  if (h <= 0) return null;
                  const r = si === segs.length - 1 ? Math.min(4, h, barW / 2) : 0;
                  return <path key={g} fill={color(g)} d={`M${x},${top + h}V${top + r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}V${top + h}Z`} />;
                })}
                <rect
                  x={PAD_L + band * i} y={PAD_T} width={band} height={innerH} rx={4}
                  fill={hover?.i === i ? 'var(--tb-text)' : 'transparent'} fillOpacity={0.04}
                  onMouseMove={(e) => {
                    const box = wrap.current!.getBoundingClientRect();
                    setHover({ i, x: e.clientX - box.left, y: e.clientY - box.top });
                  }}
                />
              </g>
            );
          })}
        </svg>
        {hover && hovered && (
          <div
            className="pointer-events-none absolute z-10 grid min-w-48 gap-1.5 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
            style={{ left: Math.min(hover.x + 14, (wrap.current?.clientWidth ?? 0) - 210), top: Math.max(0, hover.y - 80) }}
          >
            <span className="font-medium">{dayLabel(hovered)} <span className="font-normal text-subtle">· UTC</span></span>
            {hoveredGroups.length ? hoveredGroups.map((g) => (
              <div key={g} className="flex items-center justify-between gap-4">
                <span className="inline-flex items-center gap-1.5 text-muted-foreground"><i className="swatch" style={{ background: color(g) }} />{seriesName(g)}</span>
                <span className="num font-medium">{show(hoveredVals!.get(g)!)}</span>
              </div>
            )) : <span className="text-subtle">No usage</span>}
          </div>
        )}
      </div>
    </div>
  );
}

import type { ReactNode } from 'react';
import type { Highlights } from '../../../../packages/shared/src/index.ts';
import { compact, dayLabel, plural, usd } from '../lib/format.ts';

export function Tile({ label, value, note, na = false, title }: { label: string; value: ReactNode; note?: ReactNode; na?: boolean; title?: string }) {
  return (
    <div className="tile">
      <span className="text-[0.82rem] text-secondary">{label}</span>
      <span className={na ? 'text-muted font-medium py-1' : 'num text-[1.45rem] font-semibold'} title={title}>{value}</span>
      {note && <span className="text-[0.75rem] text-muted">{note}</span>}
    </div>
  );
}

export const Tiles = ({ children }: { children: ReactNode }) => (
  <section className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(130px,1fr))]">{children}</section>
);

/** Segmented control. Items: [value, label]. */
export function Seg<T extends string>({ items, value, onChange }: { items: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex border border-line rounded-lg overflow-hidden" role="group">
      {items.map(([v, l]) => (
        <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}
          className={`px-3 py-1.5 text-[0.88rem] ${v === value ? 'bg-surface-2 text-primary font-semibold' : 'text-secondary'}`}>{l}</button>
      ))}
    </div>
  );
}

export function HighlightTiles({ h, tokens, costs, streaks, windowLabel }: {
  h: Omit<Partial<Highlights>, 'bestDay'> & { bestDay?: { day: string; tokens?: number } | null }; tokens: boolean; costs: boolean; streaks: boolean; windowLabel: string;
}) {
  const tiles: ReactNode[] = [];
  if (tokens && h.totalTokens !== undefined) tiles.push(<Tile key="t" label="Total tokens" value={compact(h.totalTokens)} note={`${windowLabel} · input + output + cache`} />);
  if (costs && h.costUsd !== undefined) {
    tiles.push(h.costUsd === null
      ? <Tile key="c" label="Estimated cost" value="Not available" note="no priced models" na />
      : <Tile key="c" label="Estimated cost" value={usd(h.costUsd)} note={h.billedUsd ? `${usd(h.billedUsd)} billed by providers; rest is an estimate` : 'API list-price estimate, not a bill'} />);
  }
  if (streaks && h.currentStreak !== undefined) {
    tiles.push(<Tile key="cs" label="Current streak" value={plural(h.currentStreak, 'day')} note="consecutive days with usage" />);
    tiles.push(<Tile key="ls" label="Longest streak" value={plural(h.longestStreak ?? 0, 'day')} note={`${plural(h.activeDays ?? 0, 'active day')} total`} />);
    if (h.bestDay) tiles.push(<Tile key="bd" label="Best day" value={dayLabel(h.bestDay.day)} note={h.bestDay.tokens !== undefined ? `${compact(h.bestDay.tokens)} tokens` : 'most active day'} />);
  }
  return tiles.length ? <Tiles>{tiles}</Tiles> : null;
}

export const Card = ({ children, className = '' }: { children: ReactNode; className?: string }) => <section className={`card ${className}`}>{children}</section>;

export const Notice = ({ children }: { children: ReactNode }) => <div className="bg-warn-bg text-warn-ink rounded-lg px-3.5 py-2.5 text-[0.9rem]">{children}</div>;

export const Loading = () => <Card><p className="text-muted">Loading…</p></Card>;

import { cn } from '@/lib/utils';

/**
 * A compact single-choice switch for card headers: a muted track with the active option raised, readable labels,
 * and an optional lead-in ("Sort by").
 */
export function Pills<T extends string>({ items, value, onChange, label, lead }: {
  items: [T, string][];
  value: T;
  onChange: (v: T) => void;
  label: string;
  lead?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      {lead && <span className="text-xs text-subtle">{lead}</span>}
      <div role="radiogroup" aria-label={label} className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
        {items.map(([v, l]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={v === value}
            onClick={() => onChange(v)}
            className={cn(
              'h-7 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
              v === value ? 'bg-card text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

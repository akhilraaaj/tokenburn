import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

/** Single-choice segmented control (one row of options; clicking the active one keeps it selected). */
export function Segmented<T extends string>({ items, value, onChange, label }: {
  items: [T, string][];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={0}
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      aria-label={label}
    >
      {items.map(([v, l]) => (
        <ToggleGroupItem key={v} value={v} className="px-2.5 text-xs">
          {l}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export const fmt = (n: number | null | undefined) => (n === null || n === undefined ? 'n/a' : n.toLocaleString('en-US'));

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'n/a';
  const a = Math.abs(n);
  const f = (v: number, s: string) => (v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')) + s;
  if (a >= 1e9) return f(n / 1e9, 'B');
  if (a >= 1e6) return f(n / 1e6, 'M');
  if (a >= 1e3) return f(n / 1e3, 'K');
  return String(Math.round(n));
}

export const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? 'n/a' : n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`;

export const dayLabel = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

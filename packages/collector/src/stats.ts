// `tokenburn stats`: local usage summary rendered in the terminal. Reads only the local DB
// (and the cached public price list for cost estimates).
import {
  activityStats, estimateCost, modelDisplayName, PROVIDER_LABELS, SOURCES, totalTokens,
  type PriceTable, type Provider, type UsageRecord,
} from '../../shared/src/index.ts';
import { c } from './ui.ts';

const { dim, bold } = c;

export function compact(n: number | null): string {
  if (n === null) return 'n/a';
  const f = (v: number, s: string) => (v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')) + s;
  if (n >= 1e9) return f(n / 1e9, 'B');
  if (n >= 1e6) return f(n / 1e6, 'M');
  if (n >= 1e3) return f(n / 1e3, 'K');
  return String(n);
}

export const usd = (n: number | null) => (n === null ? 'n/a' : n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`);

const addN = (a: number | null, b: number | null | undefined) => (b === null || b === undefined ? a : (a ?? 0) + b);
const BLOCKS = '▁▂▃▄▅▆▇█';

function sparkline(values: number[]): string {
  const max = Math.max(...values);
  if (max <= 0) return dim('·'.repeat(values.length));
  return values.map((v) => (v <= 0 ? dim('·') : c.blue(BLOCKS[Math.min(7, Math.floor((v / max) * 7.999))]))).join('');
}

function pad(s: string, n: number, right = false) {
  // eslint-disable-next-line no-control-regex
  const len = s.replace(/\x1b\[[0-9;]*m/g, '').length;
  return right ? ' '.repeat(Math.max(0, n - len)) + s : s + ' '.repeat(Math.max(0, n - len));
}

/** Best-known cost of one record: tool-reported, else list-price estimate, else null. */
function recordCost(r: UsageRecord, prices: PriceTable): number | null {
  return r.cost_kind && typeof r.cost_usd === 'number' ? r.cost_usd : estimateCost(prices, r);
}

interface Tot { req: number; input: number | null; output: number | null; cr: number | null; cw: number | null; cost: number | null; billed: number | null; unpriced: number }
const emptyTot = (): Tot => ({ req: 0, input: null, output: null, cr: null, cw: null, cost: null, billed: null, unpriced: 0 });

function add(t: Tot, r: UsageRecord, prices: PriceTable) {
  t.req += r.event_count;
  t.input = addN(t.input, r.input_tokens);
  t.output = addN(t.output, r.output_tokens);
  t.cr = addN(t.cr, r.cache_read_tokens);
  t.cw = addN(t.cw, r.cache_write_tokens);
  const c = recordCost(r, prices);
  if (c === null) t.unpriced += r.event_count;
  else t.cost = (t.cost ?? 0) + c;
  if (r.cost_kind === 'billed') t.billed = addN(t.billed, r.cost_usd);
}

export function renderStats(events: UsageRecord[], days: number, prices: PriceTable = {}): string {
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
  const inRange = events.filter((e) => e.occurred_at.slice(0, 10) >= since);
  if (!inRange.length) return `No usage in the last ${days} days on this machine. Use one of your AI tools, then run \`tokenburn stats\` again.`;
  const dayList: string[] = [];
  for (let d = new Date(since + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) dayList.push(d.toISOString().slice(0, 10));

  // Highlights across all tools. Streaks use all history, not just the selected window.
  const all = emptyTot();
  inRange.forEach((r) => add(all, r, prices));
  const perDayAll = new Map<string, { events: number; tokens: number }>();
  for (const r of events) {
    const d = r.occurred_at.slice(0, 10);
    const cur = perDayAll.get(d) ?? { events: 0, tokens: 0 };
    perDayAll.set(d, { events: cur.events + r.event_count, tokens: cur.tokens + totalTokens(r) });
  }
  const act = activityStats([...perDayAll.entries()].map(([day, v]) => ({ day, ...v })), today);
  const bestInRange = activityStats([...perDayAll.entries()].filter(([d]) => d >= since).map(([day, v]) => ({ day, ...v })), today).bestDay;
  const totalTok = inRange.reduce((n, r) => n + totalTokens(r), 0);

  const out: string[] = [
    `${bold(`Your usage · last ${days} days`)} ${dim('(UTC, this machine)')}`,
    `  ${bold(compact(totalTok))} total tokens ${dim('(input + output + cache, all tools; tools count differently, see below)')}`,
    `  ${bold(usd(all.cost))} estimated cost ${dim(all.billed ? `(${usd(all.billed)} billed by providers; rest is an API-list-price estimate, not your bill)` : '(API list prices, not your bill)')}` +
      (all.unpriced ? dim(` · ${all.unpriced.toLocaleString('en-US')} requests unpriced`) : ''),
    `  Best day ${bestInRange ? `${bestInRange.day} (${compact(bestInRange.tokens)} tokens)` : 'n/a'} · ` +
      `current streak ${bold(`${act.currentStreak} day${act.currentStreak === 1 ? '' : 's'}`)} · longest ${act.longestStreak} day${act.longestStreak === 1 ? '' : 's'}`,
    '',
  ];

  const providers = [...new Set(inRange.map((e) => e.provider))] as Provider[];
  for (const p of providers) {
    const rows = inRange.filter((e) => e.provider === p);
    const src = SOURCES[rows[0].usage_source];
    const tot = emptyTot();
    const perDay = new Map<string, number>();
    const models = new Map<string, Tot>();
    const sessions = new Set<string>();
    for (const r of rows) {
      add(tot, r, prices);
      perDay.set(r.occurred_at.slice(0, 10), (perDay.get(r.occurred_at.slice(0, 10)) ?? 0) + (r.output_tokens ?? 0));
      if (r.session_id) sessions.add(r.session_id);
      const m = models.get(r.model_id) ?? emptyTot();
      add(m, r, prices);
      models.set(r.model_id, m);
    }
    out.push(`${c.orange('■')} ${bold(PROVIDER_LABELS[p])}  ${dim(src.label)}`);
    out.push(`  ${compact(tot.output)} output · ${compact(tot.input)} input ${dim(`(${src.inputNote})`)}`);
    out.push(`  ${compact(tot.cr)} cache read · ${compact(tot.cw)} cache write · ${tot.req.toLocaleString('en-US')} requests` +
      (src.sessions ? ` · ${sessions.size} sessions` : dim(' · sessions n/a')) + ` · ${usd(tot.cost)}${tot.billed ? ' (billed)' : ' est.'}`);
    out.push(`  ${sparkline(dayList.map((d) => perDay.get(d) ?? 0))}  ${dim('output/day')}`);
    out.push(dim(`  ${pad('model', 32)}${pad('requests', 10, true)}${pad('input', 9, true)}${pad('output', 9, true)}${pad('cache rd', 10, true)}${pad('est. cost', 11, true)}`));
    for (const [model, m] of [...models.entries()].sort((a, b) => b[1].req - a[1].req)) {
      const name = modelDisplayName(model);
      out.push(`  ${pad(name.length > 31 ? name.slice(0, 30) + '…' : name, 32)}${pad(m.req.toLocaleString('en-US'), 10, true)}` +
        `${pad(compact(m.input), 9, true)}${pad(compact(m.output), 9, true)}${pad(compact(m.cr), 10, true)}${pad(usd(m.cost), 11, true)}`);
    }
    out.push('');
  }
  return out.join('\n');
}

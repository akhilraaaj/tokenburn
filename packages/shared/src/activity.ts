// Activity highlights: total tokens, best day, current and longest streak. Days are UTC.

export interface DayTotal {
  day: string; // YYYY-MM-DD
  events: number;
  tokens: number; // input + output + cache read + cache write, counting unreported fields as 0
}

export interface ActivityStats {
  activeDays: number;
  bestDay: DayTotal | null;
  currentStreak: number;
  longestStreak: number;
  longestStreakEnd: string | null;
}

const nextDay = (d: string) => {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

/**
 * A day counts as active with at least one request from any tool. The current streak stays alive
 * through today if yesterday was active, so it doesn't reset before you've had a chance to work.
 */
export function activityStats(days: DayTotal[], today = new Date().toISOString().slice(0, 10)): ActivityStats {
  const byDay = new Map<string, DayTotal>();
  for (const d of days) {
    if (d.events <= 0) continue;
    const prev = byDay.get(d.day);
    byDay.set(d.day, prev ? { day: d.day, events: prev.events + d.events, tokens: prev.tokens + d.tokens } : { ...d });
  }
  const active = [...byDay.keys()].sort();
  let bestDay: DayTotal | null = null;
  for (const d of byDay.values()) if (!bestDay || d.tokens > bestDay.tokens) bestDay = d;

  let longest = 0, longestEnd: string | null = null, run = 0, prev: string | null = null;
  for (const d of active) {
    run = prev && nextDay(prev) === d ? run + 1 : 1;
    if (run > longest) { longest = run; longestEnd = d; }
    prev = d;
  }

  let current = 0;
  const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  let cursor = byDay.has(today) ? today : byDay.has(yesterday) ? yesterday : null;
  while (cursor && byDay.has(cursor)) {
    current++;
    cursor = new Date(Date.parse(cursor + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
  }
  return { activeDays: active.length, bestDay, currentStreak: current, longestStreak: longest, longestStreakEnd: longestEnd };
}

export const totalTokens = (r: { input_tokens?: number | null; output_tokens?: number | null; cache_read_tokens?: number | null; cache_write_tokens?: number | null }) =>
  (r.input_tokens ?? 0) + (r.output_tokens ?? 0) + (r.cache_read_tokens ?? 0) + (r.cache_write_tokens ?? 0);

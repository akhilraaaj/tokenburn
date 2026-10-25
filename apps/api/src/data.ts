// Read-side queries shared by the dashboard, the public profile and the CLI summary.
import { activityStats, type ActivityStats } from '../../../packages/shared/src/activity.ts';
import { rowTokens, type DailyRow, type Highlights } from '../../../packages/shared/src/web.ts';
import type { Env } from './util.ts';

export { rowTokens, type DailyRow, type Highlights };

/** Device-scoped aggregates and account-scoped events, combined per day/model. SUM over all-NULL stays NULL ("not reported"). */
export async function dailyRows(env: Env, userId: string, since: string): Promise<DailyRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT provider, usage_source, model_id, day, billing_mode, measurement_type,
            SUM(event_count) AS events, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
            SUM(incomplete_events) AS incomplete_events, SUM(cost_usd) AS cost_usd, SUM(billed_cost_usd) AS billed_cost_usd,
            SUM(unpriced_events) AS unpriced_events
     FROM (
       SELECT provider, usage_source, model_id, day, billing_mode, measurement_type, event_count, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens, incomplete_events, cost_usd, billed_cost_usd, unpriced_events
       FROM usage_daily WHERE user_id = ?1 AND day >= ?2
       UNION ALL
       SELECT provider, usage_source, model_id, substr(occurred_at, 1, 10), billing_mode, measurement_type, event_count, input_tokens,
              output_tokens, cache_read_tokens, cache_write_tokens,
              CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN event_count ELSE 0 END,
              cost_usd, billed_cost_usd, CASE WHEN cost_usd IS NULL THEN event_count ELSE 0 END
       FROM account_events WHERE user_id = ?1 AND occurred_at >= ?2
     )
     GROUP BY provider, usage_source, model_id, day, billing_mode, measurement_type
     ORDER BY day`,
  ).bind(userId, since).all<DailyRow>();
  return results;
}

export async function sessionCounts(env: Env, userId: string, since: string): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    'SELECT provider, COUNT(*) AS sessions FROM usage_sessions WHERE user_id = ? AND last_at >= ? GROUP BY provider',
  ).bind(userId, since).all<{ provider: string; sessions: number }>();
  return Object.fromEntries(results.map((r) => [r.provider, r.sessions]));
}

/** Streaks need all history, not just the visible window: one row per active day across every source. */
export async function allTimeActivity(env: Env, userId: string): Promise<ActivityStats> {
  const { results } = await env.DB.prepare(
    `SELECT day, SUM(events) AS events, SUM(tokens) AS tokens FROM (
       SELECT day, event_count AS events,
              COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0) AS tokens
       FROM usage_daily WHERE user_id = ?1
       UNION ALL
       SELECT substr(occurred_at, 1, 10), event_count,
              COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0)
       FROM account_events WHERE user_id = ?1
     ) GROUP BY day`,
  ).bind(userId).all<{ day: string; events: number; tokens: number }>();
  return activityStats(results);
}

export function sinceDays(req: Request, fallback = 90) {
  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get('days') ?? fallback) || fallback, 1), 730);
  return { days, since: new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10) };
}

/** Window totals plus all-time streaks. */
export function highlights(rows: DailyRow[], activity: ActivityStats): Highlights {
  let cost: number | null = null, billed: number | null = null, unpriced = 0, events = 0, total = 0;
  const perDay = new Map<string, number>();
  for (const r of rows) {
    total += rowTokens(r);
    events += r.events;
    unpriced += r.unpriced_events ?? 0;
    if (r.cost_usd !== null) cost = (cost ?? 0) + r.cost_usd;
    if (r.billed_cost_usd !== null) billed = (billed ?? 0) + r.billed_cost_usd;
    perDay.set(r.day, (perDay.get(r.day) ?? 0) + rowTokens(r));
  }
  let bestDay: Highlights['bestDay'] = null;
  for (const [day, tokens] of perDay) if (!bestDay || tokens > bestDay.tokens) bestDay = { day, tokens };
  return {
    totalTokens: total, costUsd: cost, billedUsd: billed, unpricedEvents: unpriced, events, bestDay,
    currentStreak: activity.currentStreak, longestStreak: activity.longestStreak, activeDays: activity.activeDays,
  };
}

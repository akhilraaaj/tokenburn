// Migration 0006 turns per-request account rows into daily totals. The dashboard must show exactly the same numbers
// before and after: the old per-request query and the new per-day table are compared on the real migration files.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = path.resolve(import.meta.dirname, '../migrations');
const run = (db: DatabaseSync, file: string) => db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));

/** How the dashboard summed account rows before 0006 (dailyRows' account_events branch, grouped per day/model). */
const OLD = `SELECT user_id, provider, usage_source, model_id, substr(occurred_at, 1, 10) AS day, billing_mode, measurement_type,
    SUM(event_count) AS events, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
    SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
    SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN event_count ELSE 0 END) AS incomplete_events,
    SUM(cost_usd) AS cost_usd, SUM(billed_cost_usd) AS billed_cost_usd,
    SUM(CASE WHEN cost_usd IS NULL THEN event_count ELSE 0 END) AS unpriced_events
  FROM account_events GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY 1, 2, 3, 4, 5, 6, 7`;
const NEW = `SELECT user_id, provider, usage_source, model_id, day, billing_mode, measurement_type, event_count AS events,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, incomplete_events, cost_usd, billed_cost_usd, unpriced_events
  FROM account_daily ORDER BY 1, 2, 3, 4, 5, 6, 7`;

describe('migration 0006: account rows per request → per day', () => {
  it('keeps every daily total, including unreported tokens and unpriced requests', () => {
    const db = new DatabaseSync(':memory:');
    for (const f of fs.readdirSync(dir).filter((f) => f < '0006').sort()) run(db, f);
    db.exec("INSERT INTO users (id, github_id, github_login, username, created_at) VALUES ('u1', 1, 'a', 'a', ''), ('u2', 2, 'b', 'b', '')");
    const ins = db.prepare(`INSERT INTO account_events (user_id, dedupe_key, provider, model_id, occurred_at, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, event_count, usage_source, measurement_type, billing_mode, cost_usd, billed_cost_usd, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'measured', ?, ?, ?, '2026-10-28T00:00:00Z')`);
    let n = 0;
    const row = (user: string, provider: string, source: string, model: string, at: string, inp: number | null, out: number | null,
      cr: number | null, cw: number | null, events: number, billing: string, cost: number | null, billed: number | null) =>
      ins.run(user, `k${n++}`, provider, model, at, inp, out, cr, cw, events, source, billing, cost, billed);
    // Several requests on one day (summed), across midnight UTC (two days), with gaps in what Cursor reported.
    row('u1', 'cursor', 'cursor_csv', 'claude-4-sonnet', '2026-10-01T09:00:00.000Z', 100, 20, 1000, null, 1, 'subscription', 0.02, null);
    row('u1', 'cursor', 'cursor_csv', 'claude-4-sonnet', '2026-10-01T23:59:59.000Z', 50, 10, 0, null, 1, 'subscription', null, null);
    row('u1', 'cursor', 'cursor_csv', 'claude-4-sonnet', '2026-10-02T00:00:00.000Z', null, 5, null, null, 1, 'subscription', 0.01, null);
    row('u1', 'cursor', 'cursor_csv', 'auto', '2026-10-01T10:00:00.000Z', null, null, null, null, 1, 'subscription', null, null);
    row('u1', 'cursor', 'cursor_csv', 'auto', '2026-10-01T11:00:00.000Z', null, null, null, null, 1, 'subscription', null, null);
    // OpenRouter: daily rows with billed cost; a second user's rows stay theirs.
    row('u1', 'openrouter', 'openrouter_activity', 'openai/gpt-4.1', '2026-10-01T00:00:00.000Z', 400, 80, 0, 0, 3, 'api', 0.5, 0.5);
    row('u2', 'cursor', 'cursor_csv', 'claude-4-sonnet', '2026-10-01T12:00:00.000Z', 7, 7, 7, 7, 1, 'api', 0.07, null);
    const before = db.prepare(OLD).all();

    run(db, '0006_account_daily.sql');

    expect(db.prepare(NEW).all()).toEqual(before);
    expect(before).toHaveLength(5); // 7 requests → 5 day rows
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'account_events'").get()).toEqual({ n: 0 });
  });
});

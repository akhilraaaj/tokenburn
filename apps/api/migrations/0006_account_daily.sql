-- Account-scoped usage (Cursor CSV, OpenRouter) as daily totals instead of one row per request: a long Cursor history
-- was tens of thousands of rows (3 rows written each, with the indexes) and every dashboard view re-added them all.
-- Now one row per user, day, tool and model, like usage_daily. Which uploads win is decided at ingest (keep the
-- larger Cursor day total, latest OpenRouter day); see ingestAccountDaily in src/index.ts.
CREATE TABLE account_daily (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  usage_source TEXT NOT NULL,
  model_id TEXT NOT NULL,
  billing_mode TEXT NOT NULL,
  measurement_type TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  incomplete_events INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  billed_cost_usd REAL,
  unpriced_events INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL,
  -- Leading (user_id, day) serves every read (one user, a day range), so no secondary index: one row written per upsert.
  PRIMARY KEY (user_id, day, provider, usage_source, model_id, billing_mode, measurement_type)
) WITHOUT ROWID;

-- Existing rows, summed per day exactly as the dashboard summed them (SUM over all-NULL stays NULL).
INSERT INTO account_daily (user_id, day, provider, usage_source, model_id, billing_mode, measurement_type, event_count,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, incomplete_events, cost_usd, billed_cost_usd,
  unpriced_events, synced_at)
SELECT user_id, substr(occurred_at, 1, 10), provider, usage_source, model_id, billing_mode, measurement_type,
  SUM(event_count), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens),
  SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN event_count ELSE 0 END),
  SUM(cost_usd), SUM(billed_cost_usd), SUM(CASE WHEN cost_usd IS NULL THEN event_count ELSE 0 END), MAX(synced_at)
FROM account_events
GROUP BY user_id, substr(occurred_at, 1, 10), provider, usage_source, model_id, billing_mode, measurement_type;

DROP TABLE account_events;

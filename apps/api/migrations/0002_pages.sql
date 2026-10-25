-- Fixed-window rate limits stored in D1 (Pages has no rate-limiting binding). Old windows are pruned by cleanup.
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
) WITHOUT ROWID;

-- Small key/value store for app housekeeping (e.g. when cleanup last ran; Pages has no cron triggers).
CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

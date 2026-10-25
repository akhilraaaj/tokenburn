-- Accounts (GitHub sign-in; no passwords stored)
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  username TEXT UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL,
  -- Set when the user deletes uploaded data; collectors seeing a newer value re-upload their full history.
  data_reset_at TEXT
);

-- Browser sessions for the dashboard (GitHub web sign-in). Token stored hashed.
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

-- Collector devices. The device token is the only credential; stored hashed.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_sync_at TEXT,
  collector_version TEXT,
  health_json TEXT,
  -- Revoked (sign-out, idle expiry): the token stops working but the device's uploaded history is kept.
  revoked_at TEXT
);
CREATE INDEX devices_user ON devices(user_id);

-- In-progress CLI logins (server-mediated GitHub device flow). The GitHub token is never stored.
CREATE TABLE login_requests (
  login_id_hash TEXT PRIMARY KEY,
  github_device_code TEXT NOT NULL,
  device_name TEXT NOT NULL,
  previous_token_hash TEXT, -- lets a re-login from the same machine resume its device
  interval_s INTEGER NOT NULL,
  next_poll_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Public profile settings. Private by default; each field must be opted into.
CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  is_public INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  show_providers INTEGER NOT NULL DEFAULT 0,
  show_models INTEGER NOT NULL DEFAULT 0,
  show_token_totals INTEGER NOT NULL DEFAULT 0,
  show_daily_trend INTEGER NOT NULL DEFAULT 0,
  show_sessions INTEGER NOT NULL DEFAULT 0,
  show_streaks INTEGER NOT NULL DEFAULT 0,
  show_costs INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Device-scoped daily aggregates (Claude Code). Replace-by-key from the collector.
-- Token columns are NULL when no event in the bucket reported the metric.
CREATE TABLE usage_daily (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  usage_source TEXT NOT NULL,
  model_id TEXT NOT NULL,
  day TEXT NOT NULL,
  billing_mode TEXT NOT NULL,
  measurement_type TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  incomplete_events INTEGER NOT NULL DEFAULT 0,
  -- Best-known cost (provider-billed, else tool estimate, else API list-price estimate) and its billed part.
  cost_usd REAL,
  billed_cost_usd REAL,
  unpriced_events INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, provider, usage_source, model_id, day, billing_mode, measurement_type)
) WITHOUT ROWID; -- no duplicate rowid table + PK index: roughly 40% smaller rows
CREATE INDEX usage_daily_user_day ON usage_daily(user_id, day);

-- One row per session; session_key is a salted hash computed on the user's machine.
CREATE TABLE usage_sessions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  session_key TEXT NOT NULL,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id, session_key)
) WITHOUT ROWID;
CREATE INDEX usage_sessions_user_last ON usage_sessions(user_id, last_at);

-- Account-level events (Cursor CSV). Deduped per user by dedupe_key.
CREATE TABLE account_events (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  event_count INTEGER NOT NULL DEFAULT 1,
  usage_source TEXT NOT NULL,
  measurement_type TEXT NOT NULL,
  billing_mode TEXT NOT NULL,
  provider_fields TEXT NOT NULL DEFAULT '{}',
  cost_usd REAL,
  billed_cost_usd REAL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (user_id, dedupe_key)
);
CREATE INDEX account_events_user_time ON account_events(user_id, occurred_at);

-- Import / sync history for connector health.
CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT,
  kind TEXT NOT NULL, -- daily_sync | cursor_import
  at TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE INDEX sync_log_user ON sync_log(user_id, at);

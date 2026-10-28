-- The daily cleanup prunes old sync history and sessions by time across all users. Without these it scans both
-- tables in full on every run, which grows with every sync.
CREATE INDEX IF NOT EXISTS sync_log_at ON sync_log(at);
CREATE INDEX IF NOT EXISTS usage_sessions_last ON usage_sessions(last_at);

-- D1 enforces foreign keys, so deleting a device runs the ON DELETE CASCADE into usage_daily and usage_sessions
-- even after their rows were removed by user_id. Without an index leading with device_id that cascade scans the
-- whole table (all users) for every device deleted.
CREATE INDEX IF NOT EXISTS usage_daily_device ON usage_daily(device_id);
CREATE INDEX IF NOT EXISTS usage_sessions_device ON usage_sessions(device_id);

-- Expired sign-in sessions and CLI login requests are pruned by expiry on sign-in and login start.
CREATE INDEX IF NOT EXISTS auth_sessions_expires ON auth_sessions(expires_at);
CREATE INDEX IF NOT EXISTS login_requests_expires ON login_requests(expires_at);

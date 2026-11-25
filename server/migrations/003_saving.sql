-- Per-user settings (token-saving toggles), under the same row-level security as other user data.
CREATE TABLE user_settings (
  user_id  uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  data     jsonb NOT NULL DEFAULT '{}'
);
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON user_settings TO harbor_app
  USING (user_id = current_setting('app.user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON user_settings TO harbor_app;

-- Auto-compact: older turns replaced by a summary. Messages created at or before summary_until
-- are covered by the summary and not sent to the model again.
ALTER TABLE chats ADD COLUMN summary text NOT NULL DEFAULT '';
ALTER TABLE chats ADD COLUMN summary_until timestamptz;

-- For the monthly savings meter.
CREATE INDEX ON messages (user_id, created_at);

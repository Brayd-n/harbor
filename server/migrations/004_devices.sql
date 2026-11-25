-- M1: desktop devices, Code mode projects, the tool audit log and image blobs.

-- A linked desktop app. Its info is reported by the app at link time and on every connection.
CREATE TABLE devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  name        text NOT NULL,
  os          text NOT NULL DEFAULT '',
  os_version  text NOT NULL DEFAULT '',
  arch        text NOT NULL DEFAULT '',
  hostname    text NOT NULL DEFAULT '',
  home_dir    text NOT NULL DEFAULT '',
  shell       text NOT NULL DEFAULT '',   -- e.g. "PowerShell 7.5.0 (pwsh)" or "GNU bash 5.2"
  last_seen   timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

-- Device-code linking: the app holds device_code (only its hash is stored), the user types or
-- follows user_code in a signed-in browser and approves. Unauthenticated until approved.
CREATE TABLE device_codes (
  code_hash   bytea PRIMARY KEY,
  user_code   text NOT NULL UNIQUE,
  name        text NOT NULL,
  info        jsonb NOT NULL DEFAULT '{}',
  device_id   uuid REFERENCES devices ON DELETE CASCADE,   -- set on approval
  expires_at  timestamptz NOT NULL
);

-- Rotating refresh tokens, bound to one device. Only hashes are stored. Presenting a used token
-- again means it was copied, so the whole device is revoked.
CREATE TABLE refresh_tokens (
  token_hash  bytea PRIMARY KEY,
  device_id   uuid NOT NULL REFERENCES devices ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX ON refresh_tokens (device_id);

ALTER TABLE auth_events ADD COLUMN device_id uuid;

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

-- The same project lives at a different path on each machine.
CREATE TABLE project_paths (
  project_id  uuid NOT NULL,
  device_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  path        text NOT NULL,
  PRIMARY KEY (project_id, device_id),
  FOREIGN KEY (project_id, user_id) REFERENCES projects (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (device_id, user_id) REFERENCES devices (id, user_id) ON DELETE CASCADE
);

ALTER TABLE chats ADD COLUMN mode text NOT NULL DEFAULT 'chat' CHECK (mode IN ('chat', 'code'));
ALTER TABLE chats ADD COLUMN project_id uuid;
ALTER TABLE chats ADD FOREIGN KEY (project_id, user_id) REFERENCES projects (id, user_id) ON DELETE SET NULL (project_id);
ALTER TABLE chats ADD COLUMN last_device_id uuid;
ALTER TABLE messages ADD COLUMN device_id uuid;

-- Audit log: every tool request, with the decision the device made.
CREATE TABLE tool_runs (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL,
  chat_id      uuid NOT NULL,
  device_id    uuid NOT NULL,
  tool         text NOT NULL,
  input        jsonb NOT NULL,
  decision     text NOT NULL CHECK (decision IN ('auto', 'approved', 'denied', 'policy_blocked', 'unavailable')),
  exit_code    int,
  duration_ms  int,
  is_error     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (chat_id, user_id) REFERENCES chats (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (device_id, user_id) REFERENCES devices (id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON tool_runs (chat_id, created_at);

-- Uploaded images, kept in Postgres so row-level security and backups cover them. Deduplicated
-- per user only, so nobody can learn whether someone else uploaded a file.
CREATE TABLE blobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  sha256      bytea NOT NULL,
  mime        text NOT NULL,
  size        int NOT NULL,
  data        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, sha256)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['devices', 'projects', 'project_paths', 'tool_runs', 'blobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY own_rows ON %I TO harbor_app
      USING (user_id = current_setting('app.user_id', true)::uuid)
      WITH CHECK (user_id = current_setting('app.user_id', true)::uuid)$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO harbor_app', t);
  END LOOP;
END $$;
GRANT USAGE ON SEQUENCE tool_runs_id_seq TO harbor_app;

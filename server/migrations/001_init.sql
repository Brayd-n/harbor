-- The app connects as the database owner for auth and admin queries. Every query on user data runs
-- inside withUser(), which switches to this role, so row-level security applies to it.
DO $$ BEGIN CREATE ROLE harbor_app NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT USAGE ON SCHEMA public TO harbor_app;

CREATE TABLE users (
  id                uuid PRIMARY KEY,
  google_sub        text NOT NULL UNIQUE,
  email             text NOT NULL,
  name              text NOT NULL DEFAULT '',
  role              text NOT NULL DEFAULT 'user' CHECK (role IN ('owner', 'user')),
  -- Random per-user key that encrypts this user's provider keys and TOTP secret,
  -- itself encrypted with MASTER_KEY (which never touches the database).
  data_key_wrapped  bytea NOT NULL,
  totp_secret_enc   bytea,
  totp_pending_enc  bytea,
  totp_last_step    bigint NOT NULL DEFAULT 0,
  disabled_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Only a SHA-256 hash of the session token is stored. A session is useless until mfa_ok.
CREATE TABLE sessions (
  token_hash  bytea PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  mfa_ok      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX ON sessions (user_id);

CREATE TABLE recovery_codes (
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  code_hash  bytea NOT NULL,
  PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE auth_events (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  kind        text NOT NULL,
  ip          text NOT NULL DEFAULT '',
  user_agent  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON auth_events (user_id, created_at);

CREATE TABLE provider_keys (
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google', 'openrouter')),
  key_enc     bytea NOT NULL,
  last4       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE chats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  title       text NOT NULL DEFAULT '',
  model       text NOT NULL,           -- "provider:model-id"
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX ON chats (user_id, updated_at DESC);

-- (chat_id, user_id) must match a chat owned by the same user.
CREATE TABLE messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     uuid NOT NULL,
  user_id     uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('user', 'assistant')),
  content     jsonb NOT NULL,          -- Block[]
  model       text,
  usage       jsonb,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (chat_id, user_id) REFERENCES chats (id, user_id) ON DELETE CASCADE
);
CREATE INDEX ON messages (chat_id, created_at);

-- Row-level security: harbor_app only ever sees rows of the user in app.user_id.
-- A missing WHERE user_id = ... returns nothing instead of other people's data.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['provider_keys', 'chats', 'messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY own_rows ON %I TO harbor_app
      USING (user_id = current_setting('app.user_id', true)::uuid)
      WITH CHECK (user_id = current_setting('app.user_id', true)::uuid)$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO harbor_app', t);
  END LOOP;
END $$;

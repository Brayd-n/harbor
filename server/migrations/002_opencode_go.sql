ALTER TABLE provider_keys DROP CONSTRAINT provider_keys_provider_check;
ALTER TABLE provider_keys ADD CONSTRAINT provider_keys_provider_check
  CHECK (provider IN ('anthropic', 'openai', 'google', 'openrouter', 'opencode-go'));

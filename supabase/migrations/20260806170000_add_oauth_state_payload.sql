-- Agent-email OAuth uses an opaque state token and a small, non-secret payload.
-- Keep provider credentials in encrypted_credentials, never in this table.
ALTER TABLE public.oauth_states
  ADD COLUMN IF NOT EXISTS state text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS oauth_states_state_key
  ON public.oauth_states (state)
  WHERE state IS NOT NULL;

NOTIFY pgrst, 'reload schema';

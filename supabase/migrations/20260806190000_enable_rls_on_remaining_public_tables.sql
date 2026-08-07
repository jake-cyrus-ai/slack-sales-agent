-- These tables are written only by trusted backend/workflow code through the
-- service role. Enabling RLS with no client policies keeps anon/authenticated
-- PostgREST callers out while the service role continues to bypass RLS.
ALTER TABLE public.ai_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attio_oauth_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.briefing_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digest_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.granola_oauth_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slack_error_events ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';

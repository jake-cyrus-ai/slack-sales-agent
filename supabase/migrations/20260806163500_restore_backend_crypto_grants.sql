-- Restore backend-only privileges for projects that applied the baseline
-- before its final privilege hardening block was added.

GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON TABLE public.app_secrets TO service_role;

GRANT EXECUTE ON FUNCTION public._get_encryption_key() TO service_role;
GRANT EXECUTE ON FUNCTION public.encrypt_token(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_token(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.encrypt_token(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_token(text, text) TO service_role;

-- Keep credential material inaccessible to browser roles.
REVOKE ALL ON TABLE public.app_secrets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._get_encryption_key() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.encrypt_token(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decrypt_token(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.encrypt_token(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decrypt_token(text, text) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

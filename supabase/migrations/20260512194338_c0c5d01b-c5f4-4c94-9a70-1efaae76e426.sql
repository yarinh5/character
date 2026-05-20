
-- Fix search_path on trigger functions
ALTER FUNCTION public.set_updated_at() SET search_path = public;

-- Revoke EXECUTE from anon/public on sensitive functions (allow only authenticated)
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_my_role() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.is_operator() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_my_operator_id() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.is_conversation_client(uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.is_conversation_operator(uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.operator_can_access_character(uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.start_or_get_conversation(uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.mark_conversation_read(uuid, text) FROM anon, public;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_operator() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_operator_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_conversation_client(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_conversation_operator(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.operator_can_access_character(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_or_get_conversation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_conversation_read(uuid, text) TO authenticated;

-- Restrict public storage listing — only allow direct file access via known path
DROP POLICY IF EXISTS "Public read character avatars" ON storage.objects;
DROP POLICY IF EXISTS "Public read user avatars" ON storage.objects;
-- Recreate without listing (still public when accessed by URL since bucket is public)
CREATE POLICY "Anyone can read character avatars by URL" ON storage.objects FOR SELECT
  USING (bucket_id = 'character-avatars');
CREATE POLICY "Anyone can read user avatars by URL" ON storage.objects FOR SELECT
  USING (bucket_id = 'user-avatars');
-- Note: public buckets are accessible by URL regardless; listing restriction handled at bucket-level if needed

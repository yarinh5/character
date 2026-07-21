-- Restore explicit Data API execute grants after the Paid Stickers migration
-- replaced RPCs whose RETURNS TABLE shape changed.

REVOKE ALL ON FUNCTION public.get_admin_sticker_catalog() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_sticker_catalog() TO authenticated;

REVOKE ALL ON FUNCTION public.get_conversation_stickers(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_conversation_stickers(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

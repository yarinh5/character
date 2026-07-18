-- Supabase default grants may grant anon explicit EXECUTE independently of PUBLIC.
REVOKE ALL ON FUNCTION public.get_operator_media_catalog(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.reserve_character_media_asset(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.release_character_media_reservation(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.create_character_media_upload_intent(UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.complete_character_media_upload(UUID) FROM anon;

GRANT EXECUTE ON FUNCTION public.get_operator_media_catalog(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_character_media_asset(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_character_media_reservation(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_character_media_upload_intent(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_character_media_upload(UUID) TO authenticated;

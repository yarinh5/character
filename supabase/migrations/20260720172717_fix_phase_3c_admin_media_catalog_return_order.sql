DROP FUNCTION public.get_admin_media_catalog(UUID);

CREATE FUNCTION public.get_admin_media_catalog(
  _conversation_id UUID
)
RETURNS TABLE (
  id UUID,
  display_name TEXT,
  status TEXT,
  ingest_status TEXT,
  content_type TEXT,
  byte_size BIGINT,
  width INTEGER,
  height INTEGER,
  is_reservable BOOLEAN,
  is_locked_reservable BOOLEAN,
  locked_derivative_status TEXT,
  locked_price_credits INTEGER,
  locked_images_enabled BOOLEAN,
  is_reserved_by_me BOOLEAN,
  my_reservation_id UUID,
  my_reservation_expires_at TIMESTAMPTZ,
  my_reservation_access_mode TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM 1
  FROM private.assert_admin_operator_identity_for_conversation(_conversation_id);

  RETURN QUERY
  SELECT *
  FROM public.get_operator_media_catalog(_conversation_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_media_catalog(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_media_catalog(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

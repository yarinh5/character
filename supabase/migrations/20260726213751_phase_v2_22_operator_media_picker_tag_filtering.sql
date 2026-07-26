-- Phase V2-22: expose safe tag metadata to the existing flat operator catalog.
-- Reservation, delivery, preview, and authorization guards are intentionally unchanged.

DROP FUNCTION public.get_operator_media_catalog(UUID);

CREATE FUNCTION public.get_operator_media_catalog(
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
  my_reservation_access_mode TEXT,
  media_tag_id UUID,
  media_tag_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _guard RECORD;
  _locked_images_enabled BOOLEAN := private.setting_bool('locked_images_enabled', false);
BEGIN
  SELECT * INTO _guard
  FROM private.assert_operator_can_view_conversation_media(_conversation_id);

  PERFORM private.expire_character_media_reservations(_guard.character_id, NULL);

  RETURN QUERY
  SELECT
    asset.id,
    asset.display_name,
    asset.status,
    asset.ingest_status,
    asset.content_type,
    asset.byte_size,
    asset.width,
    asset.height,
    (
      asset.status IN ('available', 'restored')
      AND asset.ingest_status = 'ready'
      AND asset.locked_price_credits IS NULL
    ) AS is_reservable,
    (
      _locked_images_enabled
      AND asset.status IN ('available', 'restored')
      AND asset.ingest_status = 'ready'
      AND asset.locked_price_credits IS NOT NULL
      AND asset.locked_derivative_status = 'ready'
    ) AS is_locked_reservable,
    asset.locked_derivative_status,
    asset.locked_price_credits,
    _locked_images_enabled,
    COALESCE(reservation.operator_id = _guard.operator_id, FALSE),
    CASE WHEN reservation.operator_id = _guard.operator_id THEN reservation.id END,
    CASE WHEN reservation.operator_id = _guard.operator_id THEN reservation.expires_at END,
    CASE WHEN reservation.operator_id = _guard.operator_id THEN reservation.intended_access_mode END,
    asset.media_tag_id,
    tag.name
  FROM public.character_media_assets asset
  JOIN public.media_tags tag ON tag.id = asset.media_tag_id
  LEFT JOIN public.character_media_reservations reservation
    ON reservation.media_asset_id = asset.id
    AND reservation.state = 'active'
  WHERE asset.character_id = _guard.character_id
  ORDER BY tag.sort_order ASC, tag.name ASC, asset.created_at DESC, asset.id DESC;
END;
$$;

-- The admin wrapper deliberately keeps its existing response contract. Use an
-- explicit projection so new operator-only tag fields do not change it.
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
  SELECT
    catalog.id,
    catalog.display_name,
    catalog.status,
    catalog.ingest_status,
    catalog.content_type,
    catalog.byte_size,
    catalog.width,
    catalog.height,
    catalog.is_reservable,
    catalog.is_locked_reservable,
    catalog.locked_derivative_status,
    catalog.locked_price_credits,
    catalog.locked_images_enabled,
    catalog.is_reserved_by_me,
    catalog.my_reservation_id,
    catalog.my_reservation_expires_at,
    catalog.my_reservation_access_mode
  FROM public.get_operator_media_catalog(_conversation_id) catalog;
END;
$$;

REVOKE ALL ON FUNCTION public.get_operator_media_catalog(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admin_media_catalog(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operator_media_catalog(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_media_catalog(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

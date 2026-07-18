-- Phase 2D-A: safe read contract for the operator media catalog.

CREATE OR REPLACE FUNCTION private.assert_operator_can_view_conversation_media(
  _conversation_id UUID
)
RETURNS TABLE (
  operator_id UUID,
  user_id UUID,
  character_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _operator_id UUID;
  _conversation public.conversations%ROWTYPE;
  _active_lock public.conversation_locks%ROWTYPE;
  _concurrency_mode TEXT := COALESCE(private.setting_text('concurrency_mode', 'open'), 'open');
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT operator.id
  INTO _operator_id
  FROM public.operators operator
  WHERE operator.user_id = _user_id
    AND operator.is_active = TRUE
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  -- Catalog cleanup locks assets next, so take the conversation lock first.
  SELECT *
  INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF _conversation.status = 'closed'::public.conversation_status THEN
    RAISE EXCEPTION 'conversation_closed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.character_operator_assignments assignment
    WHERE assignment.character_id = _conversation.character_id
      AND assignment.operator_id = _operator_id
  ) THEN
    RAISE EXCEPTION 'operator_not_assigned_to_character';
  END IF;

  IF _concurrency_mode = 'lock' THEN
    SELECT *
    INTO _active_lock
    FROM public.conversation_locks conversation_lock
    WHERE conversation_lock.conversation_id = _conversation_id
      AND conversation_lock.released_at IS NULL
      AND conversation_lock.expires_at > clock_timestamp()
    FOR UPDATE;

    IF FOUND AND _active_lock.locked_by_operator_id <> _operator_id THEN
      RAISE EXCEPTION 'conversation_locked_by_other_operator';
    END IF;
  END IF;

  -- This read guard deliberately never acquires or extends a conversation lock.
  RETURN QUERY SELECT _operator_id, _user_id, _conversation.character_id;
END;
$$;

DROP FUNCTION IF EXISTS public.get_operator_media_catalog(UUID);

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
  is_reserved_by_me BOOLEAN,
  my_reservation_id UUID,
  my_reservation_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _guard RECORD;
BEGIN
  SELECT *
  INTO _guard
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
    (asset.status IN ('available', 'restored') AND asset.ingest_status = 'ready') AS is_reservable,
    COALESCE(reservation.operator_id = _guard.operator_id, FALSE) AS is_reserved_by_me,
    CASE WHEN reservation.operator_id = _guard.operator_id THEN reservation.id END AS my_reservation_id,
    CASE WHEN reservation.operator_id = _guard.operator_id THEN reservation.expires_at END AS my_reservation_expires_at
  FROM public.character_media_assets asset
  LEFT JOIN public.character_media_reservations reservation
    ON reservation.media_asset_id = asset.id
    AND reservation.state = 'active'
  WHERE asset.character_id = _guard.character_id
  ORDER BY asset.created_at DESC, asset.id DESC;
END;
$$;

REVOKE ALL ON FUNCTION private.assert_operator_can_view_conversation_media(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_operator_media_catalog(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operator_media_catalog(UUID) TO authenticated;

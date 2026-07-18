-- A consumed media message changes the conversation to answered through the
-- existing message trigger. Release must use the same non-closed guard as send.

CREATE OR REPLACE FUNCTION public.release_character_media_reservation(
  _reservation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _conversation_id UUID;
  _asset_id UUID;
  _reservation public.character_media_reservations%ROWTYPE;
  _asset public.character_media_assets%ROWTYPE;
  _guard RECORD;
  _is_admin BOOLEAN := public.is_admin();
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT r.conversation_id, r.media_asset_id
  INTO _conversation_id, _asset_id
  FROM public.character_media_reservations r
  WHERE r.id = _reservation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_reservation_not_found';
  END IF;

  IF _is_admin THEN
    PERFORM 1
    FROM public.conversations c
    WHERE c.id = _conversation_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'conversation_not_found';
    END IF;
  ELSE
    SELECT * INTO _guard
    FROM private.assert_operator_can_send_conversation_message(_conversation_id);
  END IF;

  PERFORM private.expire_character_media_reservations(NULL, _asset_id);

  SELECT *
  INTO _asset
  FROM public.character_media_assets a
  WHERE a.id = _asset_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_asset_not_found';
  END IF;

  SELECT *
  INTO _reservation
  FROM public.character_media_reservations r
  WHERE r.id = _reservation_id
  FOR UPDATE;

  IF _reservation.state <> 'active' THEN
    RETURN jsonb_build_object('reservation_id', _reservation.id, 'state', _reservation.state);
  END IF;

  IF NOT _is_admin AND _guard.operator_id <> _reservation.operator_id THEN
    RAISE EXCEPTION 'media_reservation_not_owned';
  END IF;

  UPDATE public.character_media_reservations
  SET
    state = 'released',
    ended_at = clock_timestamp(),
    ended_by_user_id = _user_id,
    ended_reason = 'released'
  WHERE id = _reservation.id;

  UPDATE public.character_media_assets
  SET
    status = _reservation.previous_asset_status,
    updated_by_user_id = _user_id
  WHERE id = _asset.id
    AND status = 'reserved';

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _user_id,
    'character_media_reservation.released',
    'character_media_reservation',
    _reservation.id::TEXT,
    jsonb_build_object('media_asset_id', _asset.id)
  );

  RETURN jsonb_build_object(
    'reservation_id', _reservation.id,
    'asset_id', _asset.id,
    'status', _reservation.previous_asset_status,
    'state', 'released'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.release_character_media_reservation(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_character_media_reservation(UUID) TO authenticated;

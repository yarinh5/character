-- Align media mutations with send_operator_message lock semantics.
-- Read-only catalog access continues to respect an existing lock without claiming one.

CREATE OR REPLACE FUNCTION private.assert_operator_can_manage_conversation_media(
  _conversation_id UUID,
  _manage_conversation_lock BOOLEAN
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
  _timeout_minutes INTEGER := GREATEST(private.setting_int('lock_timeout_minutes', 10), 1);
  _acquire_result JSONB;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF _manage_conversation_lock THEN
    PERFORM public.cleanup_expired_conversation_locks();
  END IF;

  SELECT o.id
  INTO _operator_id
  FROM public.operators o
  WHERE o.user_id = _user_id
    AND o.is_active = true
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations c
  WHERE c.id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF _conversation.status <> 'open'::public.conversation_status THEN
    RAISE EXCEPTION 'conversation_closed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.character_operator_assignments coa
    WHERE coa.character_id = _conversation.character_id
      AND coa.operator_id = _operator_id
  ) THEN
    RAISE EXCEPTION 'operator_not_assigned_to_character';
  END IF;

  IF _concurrency_mode = 'lock' THEN
    SELECT *
    INTO _active_lock
    FROM public.conversation_locks l
    WHERE l.conversation_id = _conversation_id
      AND l.released_at IS NULL
      AND l.expires_at > clock_timestamp()
    FOR UPDATE;

    IF FOUND AND _active_lock.locked_by_operator_id <> _operator_id THEN
      RAISE EXCEPTION 'conversation_locked_by_other_operator';
    END IF;

    IF _manage_conversation_lock THEN
      IF NOT FOUND THEN
        _acquire_result := public.acquire_conversation_lock(_conversation_id);
        IF COALESCE((_acquire_result->>'acquired')::BOOLEAN, false) IS NOT TRUE THEN
          RAISE EXCEPTION 'conversation_locked_by_other_operator';
        END IF;
      ELSE
        UPDATE public.conversation_locks
        SET
          last_activity_at = clock_timestamp(),
          expires_at = clock_timestamp() + make_interval(mins => _timeout_minutes)
        WHERE conversation_id = _conversation_id;
      END IF;
    END IF;
  ELSIF _concurrency_mode = 'warning' AND _manage_conversation_lock THEN
    _acquire_result := public.acquire_conversation_lock(_conversation_id);
  END IF;

  RETURN QUERY SELECT _operator_id, _user_id, _conversation.character_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_operator_can_manage_conversation_media(
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
BEGIN
  RETURN QUERY
  SELECT *
  FROM private.assert_operator_can_manage_conversation_media(_conversation_id, false);
END;
$$;

CREATE OR REPLACE FUNCTION private.expire_character_media_reservations(
  _character_id UUID DEFAULT NULL,
  _asset_id UUID DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _candidate RECORD;
  _asset public.character_media_assets%ROWTYPE;
  _reservation public.character_media_reservations%ROWTYPE;
  _expired_count INTEGER := 0;
BEGIN
  FOR _candidate IN
    SELECT r.id AS reservation_id, r.media_asset_id
    FROM public.character_media_reservations r
    JOIN public.character_media_assets a ON a.id = r.media_asset_id
    WHERE r.state = 'active'
      AND r.expires_at <= clock_timestamp()
      AND (_character_id IS NULL OR a.character_id = _character_id)
      AND (_asset_id IS NULL OR r.media_asset_id = _asset_id)
    ORDER BY r.media_asset_id, r.id
  LOOP
    -- Callers lock the conversation first. Expiry then consistently locks asset before reservation.
    SELECT *
    INTO _asset
    FROM public.character_media_assets a
    WHERE a.id = _candidate.media_asset_id
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    SELECT *
    INTO _reservation
    FROM public.character_media_reservations r
    WHERE r.id = _candidate.reservation_id
    FOR UPDATE SKIP LOCKED;

    IF NOT FOUND
      OR _reservation.state <> 'active'
      OR _reservation.expires_at > clock_timestamp() THEN
      CONTINUE;
    END IF;

    UPDATE public.character_media_reservations
    SET
      state = 'expired',
      ended_at = clock_timestamp(),
      ended_reason = 'expired'
    WHERE id = _reservation.id
      AND state = 'active';

    UPDATE public.character_media_assets
    SET
      status = _reservation.previous_asset_status,
      updated_by_user_id = NULL
    WHERE id = _asset.id
      AND status = 'reserved';

    INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (
      NULL,
      'character_media_reservation.expired',
      'character_media_reservation',
      _reservation.id::TEXT,
      jsonb_build_object('media_asset_id', _asset.id)
    );

    _expired_count := _expired_count + 1;
  END LOOP;

  RETURN _expired_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_character_media_asset(
  _conversation_id UUID,
  _asset_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _guard RECORD;
  _asset public.character_media_assets%ROWTYPE;
  _reservation public.character_media_reservations%ROWTYPE;
  _expires_at TIMESTAMPTZ := clock_timestamp() + INTERVAL '5 minutes';
BEGIN
  SELECT * INTO _guard
  FROM private.assert_operator_can_manage_conversation_media(_conversation_id, true);

  PERFORM private.expire_character_media_reservations(NULL, _asset_id);

  SELECT *
  INTO _asset
  FROM public.character_media_assets a
  WHERE a.id = _asset_id
    AND a.character_id = _guard.character_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_asset_not_found';
  END IF;

  IF _asset.ingest_status <> 'ready' THEN
    RAISE EXCEPTION 'media_asset_not_ready';
  END IF;

  IF _asset.status NOT IN ('available', 'restored') THEN
    RAISE EXCEPTION 'media_asset_not_reservable';
  END IF;

  INSERT INTO public.character_media_reservations (
    media_asset_id,
    conversation_id,
    operator_id,
    reserved_by_user_id,
    previous_asset_status,
    expires_at
  )
  VALUES (
    _asset.id,
    _conversation_id,
    _guard.operator_id,
    _guard.user_id,
    _asset.status,
    _expires_at
  )
  RETURNING * INTO _reservation;

  UPDATE public.character_media_assets
  SET
    status = 'reserved',
    updated_by_user_id = _guard.user_id
  WHERE id = _asset.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _guard.user_id,
    'character_media_asset.reserved',
    'character_media_asset',
    _asset.id::TEXT,
    jsonb_build_object(
      'reservation_id', _reservation.id,
      'conversation_id', _conversation_id,
      'expires_at', _expires_at
    )
  );

  RETURN jsonb_build_object(
    'reservation_id', _reservation.id,
    'asset_id', _asset.id,
    'expires_at', _expires_at,
    'status', 'reserved'
  );
END;
$$;

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

  -- Identify lock keys without locking; the mutation order below is conversation, asset, reservation.
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
    FROM private.assert_operator_can_manage_conversation_media(_conversation_id, true);
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

REVOKE ALL ON FUNCTION private.assert_operator_can_manage_conversation_media(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_operator_can_manage_conversation_media(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.expire_character_media_reservations(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_character_media_asset(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.release_character_media_reservation(UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.reserve_character_media_asset(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_character_media_reservation(UUID) TO authenticated;

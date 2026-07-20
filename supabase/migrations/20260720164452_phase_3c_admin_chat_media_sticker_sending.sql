-- Phase 3C: Admin chat can use the same controlled operator identity as staff.
-- Admin actions remain attributed to an assigned, active operator record and
-- therefore obey the same conversation and reservation locks.

CREATE OR REPLACE FUNCTION private.assert_admin_operator_identity_for_conversation(
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
  _character_id UUID;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  SELECT o.id
  INTO _operator_id
  FROM public.operators o
  WHERE o.user_id = _user_id
    AND o.is_active = TRUE
    AND o.deleted_at IS NULL
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'admin_operator_profile_required';
  END IF;

  SELECT c.character_id
  INTO _character_id
  FROM public.conversations c
  WHERE c.id = _conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.character_operator_assignments coa
    WHERE coa.character_id = _character_id
      AND coa.operator_id = _operator_id
  ) THEN
    RAISE EXCEPTION 'admin_not_assigned_to_character';
  END IF;

  RETURN QUERY SELECT _operator_id, _user_id, _character_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_admin_can_send_conversation_message(
  _conversation_id UUID
)
RETURNS TABLE (
  operator_id UUID,
  user_id UUID,
  concurrency_mode TEXT
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
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_media_catalog(
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
  my_reservation_expires_at TIMESTAMPTZ,
  my_reservation_access_mode TEXT,
  is_locked_reservable BOOLEAN,
  locked_price_credits INTEGER,
  locked_derivative_status TEXT,
  locked_images_enabled BOOLEAN
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

CREATE OR REPLACE FUNCTION public.reserve_admin_character_media_asset(
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
  _result JSONB;
BEGIN
  SELECT * INTO _guard
  FROM private.assert_admin_can_send_conversation_message(_conversation_id);

  SELECT public.reserve_character_media_for_delivery(
    _conversation_id,
    _asset_id,
    'standard'
  ) INTO _result;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _guard.user_id,
    'admin_media.reserved',
    'character_media_reservation',
    COALESCE(_result->>'reservation_id', _asset_id::TEXT),
    jsonb_build_object(
      'actor_kind', 'admin',
      'conversation_id', _conversation_id,
      'media_asset_id', _asset_id
    )
  );

  RETURN _result;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_admin_character_media_reservation(
  _reservation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _reservation public.character_media_reservations%ROWTYPE;
  _guard RECORD;
  _result JSONB;
BEGIN
  SELECT *
  INTO _reservation
  FROM public.character_media_reservations r
  WHERE r.id = _reservation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_reservation_not_found';
  END IF;

  SELECT * INTO _guard
  FROM private.assert_admin_can_send_conversation_message(_reservation.conversation_id);

  IF _reservation.operator_id <> _guard.operator_id THEN
    RAISE EXCEPTION 'media_reservation_not_owned';
  END IF;

  SELECT public.release_character_media_reservation(_reservation_id)
  INTO _result;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _guard.user_id,
    'admin_media.released',
    'character_media_reservation',
    _reservation_id::TEXT,
    jsonb_build_object('actor_kind', 'admin', 'conversation_id', _reservation.conversation_id)
  );

  RETURN _result;
END;
$$;

CREATE OR REPLACE FUNCTION public.send_admin_media_message(
  _reservation_id UUID,
  _caption TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _reservation public.character_media_reservations%ROWTYPE;
  _guard RECORD;
  _result JSONB;
BEGIN
  SELECT *
  INTO _reservation
  FROM public.character_media_reservations r
  WHERE r.id = _reservation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_reservation_not_found';
  END IF;

  SELECT * INTO _guard
  FROM private.assert_admin_can_send_conversation_message(_reservation.conversation_id);

  IF _reservation.operator_id <> _guard.operator_id THEN
    RAISE EXCEPTION 'media_reservation_not_owned';
  END IF;

  SELECT public.send_operator_media_message(_reservation_id, _caption)
  INTO _result;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _guard.user_id,
    'admin_media.message_sent',
    'message_attachment',
    COALESCE(_result->'attachment'->>'id', _reservation_id::TEXT),
    jsonb_build_object(
      'actor_kind', 'admin',
      'conversation_id', _reservation.conversation_id,
      'reservation_id', _reservation_id,
      'already_sent', COALESCE((_result->>'already_sent')::BOOLEAN, FALSE)
    )
  );

  RETURN _result;
END;
$$;

ALTER TABLE private.sticker_send_attempts
  DROP CONSTRAINT sticker_send_attempts_actor_kind_check,
  ADD CONSTRAINT sticker_send_attempts_actor_kind_check
    CHECK (actor_kind IN ('client', 'operator', 'admin'));

ALTER TABLE private.conversation_sticker_rate_limits
  DROP CONSTRAINT conversation_sticker_rate_limits_actor_kind_check,
  ADD CONSTRAINT conversation_sticker_rate_limits_actor_kind_check
    CHECK (actor_kind IN ('client', 'operator', 'admin'));

CREATE OR REPLACE FUNCTION private.send_sticker_message(
  _conversation_id UUID,
  _sticker_id UUID,
  _idempotency_key UUID,
  _actor_kind TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _operator_guard RECORD;
  _client_guard RECORD;
  _sticker RECORD;
  _attempt private.sticker_send_attempts%ROWTYPE;
  _message public.messages%ROWTYPE;
  _message_sticker public.message_stickers%ROWTYPE;
  _conversation_character_id UUID;
  _fingerprint TEXT := format('sticker:%s:%s:%s', _actor_kind, _conversation_id, _sticker_id);
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF _idempotency_key IS NULL THEN RAISE EXCEPTION 'sticker_idempotency_key_required'; END IF;

  IF _actor_kind = 'client' THEN
    SELECT * INTO _client_guard FROM private.assert_client_can_send_sticker_message(_conversation_id);
  ELSIF _actor_kind = 'operator' THEN
    SELECT * INTO _operator_guard FROM private.assert_operator_can_send_conversation_message(_conversation_id);
  ELSIF _actor_kind = 'admin' THEN
    SELECT * INTO _operator_guard FROM private.assert_admin_can_send_conversation_message(_conversation_id);
  ELSE
    RAISE EXCEPTION 'invalid_sticker_sender';
  END IF;

  SELECT c.character_id INTO _conversation_character_id
  FROM public.conversations c
  WHERE c.id = _conversation_id;

  SELECT * INTO _attempt
  FROM private.sticker_send_attempts a
  WHERE a.actor_user_id = _user_id
    AND a.idempotency_key = _idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF _attempt.request_fingerprint <> _fingerprint THEN RAISE EXCEPTION 'sticker_idempotency_key_reused'; END IF;
    IF _attempt.status <> 'succeeded' THEN RAISE EXCEPTION 'sticker_send_in_progress'; END IF;
    SELECT * INTO _message FROM public.messages m WHERE m.id = _attempt.message_id;
    SELECT * INTO _message_sticker FROM public.message_stickers ms WHERE ms.message_id = _attempt.message_id;
    RETURN jsonb_build_object(
      'message', to_jsonb(_message),
      'message_sticker', jsonb_build_object(
        'id', _message_sticker.id,
        'message_id', _message_sticker.message_id,
        'sticker_id', _message_sticker.sticker_id,
        'sticker_name_snapshot', _message_sticker.sticker_name_snapshot,
        'collection_name_snapshot', _message_sticker.collection_name_snapshot,
        'created_at', _message_sticker.created_at
      ),
      'already_sent', true
    );
  END IF;

  IF private.setting_bool('stickers_enabled', false) IS NOT TRUE THEN RAISE EXCEPTION 'stickers_disabled'; END IF;

  SELECT s.id, s.name AS sticker_name, sc.name AS collection_name
  INTO _sticker
  FROM public.stickers s
  JOIN public.sticker_collections sc ON sc.id = s.collection_id
  WHERE s.id = _sticker_id
    AND s.is_active = TRUE
    AND s.ingest_status = 'ready'
    AND sc.is_active = TRUE
    AND (sc.character_id IS NULL OR sc.character_id = _conversation_character_id);

  IF NOT FOUND THEN RAISE EXCEPTION 'sticker_not_available'; END IF;

  INSERT INTO private.sticker_send_attempts (
    actor_user_id, actor_kind, conversation_id, sticker_id, idempotency_key, request_fingerprint
  )
  VALUES (_user_id, _actor_kind, _conversation_id, _sticker_id, _idempotency_key, _fingerprint)
  ON CONFLICT (actor_user_id, idempotency_key) DO NOTHING
  RETURNING * INTO _attempt;

  IF NOT FOUND THEN
    SELECT * INTO _attempt
    FROM private.sticker_send_attempts a
    WHERE a.actor_user_id = _user_id
      AND a.idempotency_key = _idempotency_key
    FOR UPDATE;
    IF _attempt.request_fingerprint <> _fingerprint THEN RAISE EXCEPTION 'sticker_idempotency_key_reused'; END IF;
    IF _attempt.status <> 'succeeded' THEN RAISE EXCEPTION 'sticker_send_in_progress'; END IF;
    SELECT * INTO _message FROM public.messages m WHERE m.id = _attempt.message_id;
    SELECT * INTO _message_sticker FROM public.message_stickers ms WHERE ms.message_id = _attempt.message_id;
    RETURN jsonb_build_object(
      'message', to_jsonb(_message),
      'message_sticker', jsonb_build_object(
        'id', _message_sticker.id,
        'message_id', _message_sticker.message_id,
        'sticker_id', _message_sticker.sticker_id,
        'sticker_name_snapshot', _message_sticker.sticker_name_snapshot,
        'collection_name_snapshot', _message_sticker.collection_name_snapshot,
        'created_at', _message_sticker.created_at
      ),
      'already_sent', true
    );
  END IF;

  PERFORM private.consume_sticker_send_rate_limit(_conversation_id, _user_id, _actor_kind);

  INSERT INTO public.messages (conversation_id, sender_type, sender_id, operator_id, content, created_at)
  VALUES (
    _conversation_id,
    CASE WHEN _actor_kind = 'client' THEN 'client'::public.sender_type ELSE 'operator'::public.sender_type END,
    _user_id,
    CASE WHEN _actor_kind = 'client' THEN NULL ELSE _operator_guard.operator_id END,
    '[sticker]',
    clock_timestamp()
  )
  RETURNING * INTO _message;

  INSERT INTO public.message_stickers (message_id, sticker_id, sticker_name_snapshot, collection_name_snapshot)
  VALUES (_message.id, _sticker.id, _sticker.sticker_name, _sticker.collection_name)
  RETURNING * INTO _message_sticker;

  UPDATE private.sticker_send_attempts
  SET message_id = _message.id,
      status = 'succeeded',
      updated_at = clock_timestamp()
  WHERE id = _attempt.id;

  IF _actor_kind = 'admin' THEN
    INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (
      _user_id,
      'admin_sticker.message_sent',
      'message_sticker',
      _message_sticker.id::TEXT,
      jsonb_build_object(
        'actor_kind', 'admin',
        'conversation_id', _conversation_id,
        'sticker_id', _sticker.id,
        'message_id', _message.id
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'message', to_jsonb(_message),
    'message_sticker', jsonb_build_object(
      'id', _message_sticker.id,
      'message_id', _message_sticker.message_id,
      'sticker_id', _message_sticker.sticker_id,
      'sticker_name_snapshot', _message_sticker.sticker_name_snapshot,
      'collection_name_snapshot', _message_sticker.collection_name_snapshot,
      'created_at', _message_sticker.created_at
    ),
    'already_sent', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.send_admin_sticker_message(
  _conversation_id UUID,
  _sticker_id UUID,
  _idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN private.send_sticker_message(
    _conversation_id,
    _sticker_id,
    _idempotency_key,
    'admin'
  );
END;
$$;

REVOKE ALL ON FUNCTION private.assert_admin_operator_identity_for_conversation(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_admin_can_send_conversation_message(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_admin_media_catalog(UUID)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reserve_admin_character_media_asset(UUID, UUID)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.release_admin_character_media_reservation(UUID)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_admin_media_message(UUID, TEXT)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_admin_sticker_message(UUID, UUID, UUID)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_admin_media_catalog(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_admin_character_media_asset(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_admin_character_media_reservation(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_admin_media_message(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_admin_sticker_message(UUID, UUID, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

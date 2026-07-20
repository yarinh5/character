-- Avoid dereferencing an unassigned operator record in the client send path.
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
  _operator_id UUID;
  _client_guard RECORD;
  _sticker RECORD;
  _attempt private.sticker_send_attempts%ROWTYPE;
  _message public.messages%ROWTYPE;
  _message_sticker public.message_stickers%ROWTYPE;
  _conversation_character_id UUID;
  _fingerprint TEXT := format('sticker:%s:%s:%s', _actor_kind, _conversation_id, _sticker_id);
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF _idempotency_key IS NULL THEN
    RAISE EXCEPTION 'sticker_idempotency_key_required';
  END IF;

  IF _actor_kind = 'client' THEN
    SELECT * INTO _client_guard
    FROM private.assert_client_can_send_sticker_message(_conversation_id);
  ELSIF _actor_kind = 'operator' THEN
    SELECT * INTO _operator_guard
    FROM private.assert_operator_can_send_conversation_message(_conversation_id);
    _operator_id := _operator_guard.operator_id;
  ELSE
    RAISE EXCEPTION 'invalid_sticker_sender';
  END IF;

  SELECT c.character_id
  INTO _conversation_character_id
  FROM public.conversations c
  WHERE c.id = _conversation_id;

  SELECT * INTO _attempt
  FROM private.sticker_send_attempts a
  WHERE a.actor_user_id = _user_id
    AND a.idempotency_key = _idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF _attempt.request_fingerprint <> _fingerprint THEN
      RAISE EXCEPTION 'sticker_idempotency_key_reused';
    END IF;

    IF _attempt.status = 'succeeded' THEN
      SELECT * INTO _message
      FROM public.messages m
      WHERE m.id = _attempt.message_id;

      SELECT * INTO _message_sticker
      FROM public.message_stickers ms
      WHERE ms.message_id = _attempt.message_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'sticker_attempt_missing_message_sticker';
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
        'already_sent', true
      );
    END IF;

    RAISE EXCEPTION 'sticker_send_in_progress';
  END IF;

  IF private.setting_bool('stickers_enabled', false) IS NOT TRUE THEN
    RAISE EXCEPTION 'stickers_disabled';
  END IF;

  SELECT
    s.id,
    s.name AS sticker_name,
    sc.name AS collection_name
  INTO _sticker
  FROM public.stickers s
  JOIN public.sticker_collections sc ON sc.id = s.collection_id
  WHERE s.id = _sticker_id
    AND s.is_active = true
    AND sc.is_active = true
    AND (sc.character_id IS NULL OR sc.character_id = _conversation_character_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sticker_not_available';
  END IF;

  INSERT INTO private.sticker_send_attempts (
    actor_user_id,
    actor_kind,
    conversation_id,
    sticker_id,
    idempotency_key,
    request_fingerprint
  )
  VALUES (
    _user_id,
    _actor_kind,
    _conversation_id,
    _sticker_id,
    _idempotency_key,
    _fingerprint
  )
  ON CONFLICT (actor_user_id, idempotency_key) DO NOTHING
  RETURNING * INTO _attempt;

  IF NOT FOUND THEN
    SELECT * INTO _attempt
    FROM private.sticker_send_attempts a
    WHERE a.actor_user_id = _user_id
      AND a.idempotency_key = _idempotency_key
    FOR UPDATE;

    IF _attempt.request_fingerprint <> _fingerprint THEN
      RAISE EXCEPTION 'sticker_idempotency_key_reused';
    END IF;

    IF _attempt.status = 'succeeded' THEN
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

    RAISE EXCEPTION 'sticker_send_in_progress';
  END IF;

  PERFORM private.consume_sticker_send_rate_limit(_conversation_id, _user_id, _actor_kind);

  INSERT INTO public.messages (
    conversation_id,
    sender_type,
    sender_id,
    operator_id,
    content,
    created_at
  )
  VALUES (
    _conversation_id,
    _actor_kind::public.sender_type,
    _user_id,
    _operator_id,
    '[sticker]',
    clock_timestamp()
  )
  RETURNING * INTO _message;

  INSERT INTO public.message_stickers (
    message_id,
    sticker_id,
    sticker_name_snapshot,
    collection_name_snapshot
  )
  VALUES (
    _message.id,
    _sticker.id,
    _sticker.sticker_name,
    _sticker.collection_name
  )
  RETURNING * INTO _message_sticker;

  UPDATE private.sticker_send_attempts
  SET
    message_id = _message.id,
    status = 'succeeded',
    updated_at = clock_timestamp()
  WHERE id = _attempt.id;

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

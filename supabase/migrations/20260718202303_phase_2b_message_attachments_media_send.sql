-- Phase 2B: operator image-message contract. No signed URLs or media rendering.

CREATE TABLE public.message_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  media_asset_id UUID NOT NULL REFERENCES public.character_media_assets(id) ON DELETE RESTRICT,
  reservation_id UUID NOT NULL UNIQUE REFERENCES public.character_media_reservations(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind = 'image'),
  position SMALLINT NOT NULL DEFAULT 0 CHECK (position >= 0),
  caption TEXT CHECK (caption IS NULL OR char_length(caption) <= 1000),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (message_id, position)
);

CREATE INDEX message_attachments_message_position_idx
  ON public.message_attachments (message_id, position);

ALTER TABLE public.message_attachments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.message_attachments FROM anon, authenticated;
GRANT SELECT (id, message_id, kind, position, caption, metadata, created_at)
  ON public.message_attachments TO authenticated;

CREATE POLICY "Clients view attachments in own conversations"
  ON public.message_attachments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.messages m
      WHERE m.id = message_id
        AND public.is_conversation_client(m.conversation_id)
    )
  );

CREATE POLICY "Operators view attachments in assigned conversations"
  ON public.message_attachments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.messages m
      WHERE m.id = message_id
        AND public.is_conversation_operator(m.conversation_id)
    )
  );

CREATE POLICY "Admins view all message attachments"
  ON public.message_attachments
  FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE OR REPLACE FUNCTION private.assert_operator_can_send_conversation_message(
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

  PERFORM public.cleanup_expired_conversation_locks();

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

  IF _conversation.status = 'closed'::public.conversation_status THEN
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
  ELSIF _concurrency_mode = 'warning' THEN
    _acquire_result := public.acquire_conversation_lock(_conversation_id);
  END IF;

  RETURN QUERY SELECT _operator_id, _user_id, _concurrency_mode;
END;
$$;

CREATE OR REPLACE FUNCTION private.create_operator_message_with_scoring(
  _conversation_id UUID,
  _operator_id UUID,
  _user_id UUID,
  _content TEXT,
  _score_metadata JSONB
)
RETURNS TABLE (
  message_id UUID,
  message JSONB,
  score_awarded INTEGER,
  streak_position INTEGER,
  consecutive_message_limit INTEGER,
  monthly_points INTEGER,
  scoring_enabled BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _content_clean TEXT := btrim(COALESCE(_content, ''));
  _scoring_enabled BOOLEAN;
  _limit INTEGER;
  _period_month DATE := date_trunc('month', clock_timestamp())::DATE;
  _last_client_at TIMESTAMPTZ;
  _streak_position INTEGER := 0;
  _score_awarded INTEGER := 0;
  _monthly_points INTEGER := 0;
  _message public.messages%ROWTYPE;
BEGIN
  IF char_length(_content_clean) = 0 OR char_length(_content_clean) > 2000 THEN
    RAISE EXCEPTION 'invalid_message_content';
  END IF;

  INSERT INTO public.messages (conversation_id, sender_type, sender_id, operator_id, content, created_at)
  VALUES (
    _conversation_id,
    'operator'::public.sender_type,
    _user_id,
    _operator_id,
    _content_clean,
    clock_timestamp()
  )
  RETURNING * INTO _message;

  _scoring_enabled := private.setting_bool('scoring_enabled', true);
  _limit := GREATEST(private.setting_int('consecutive_message_limit', 3), 0);

  IF _scoring_enabled AND _limit > 0 THEN
    SELECT max(m.created_at)
    INTO _last_client_at
    FROM public.messages m
    WHERE m.conversation_id = _conversation_id
      AND m.sender_type = 'client'::public.sender_type;

    SELECT COUNT(*)::INTEGER
    INTO _streak_position
    FROM public.messages m
    WHERE m.conversation_id = _conversation_id
      AND m.sender_type = 'operator'::public.sender_type
      AND m.operator_id = _operator_id
      AND m.created_at > COALESCE(_last_client_at, '-infinity'::TIMESTAMPTZ);

    IF _streak_position <= _limit THEN
      _score_awarded := 1;

      INSERT INTO public.operator_score_events (
        operator_id,
        user_id,
        conversation_id,
        message_id,
        points,
        period_month,
        streak_position,
        limit_applied,
        reason,
        metadata
      )
      VALUES (
        _operator_id,
        _user_id,
        _conversation_id,
        _message.id,
        _score_awarded,
        _period_month,
        _streak_position,
        _limit,
        'operator_message',
        COALESCE(_score_metadata, '{}'::JSONB)
      );
    END IF;

    INSERT INTO public.operator_monthly_scores (operator_id, period_month, points, message_count)
    VALUES (_operator_id, _period_month, _score_awarded, 1)
    ON CONFLICT (operator_id, period_month)
    DO UPDATE SET
      points = public.operator_monthly_scores.points + EXCLUDED.points,
      message_count = public.operator_monthly_scores.message_count + EXCLUDED.message_count,
      updated_at = clock_timestamp()
    RETURNING points INTO _monthly_points;
  END IF;

  RETURN QUERY
  SELECT
    _message.id,
    to_jsonb(_message),
    _score_awarded,
    _streak_position,
    _limit,
    _monthly_points,
    _scoring_enabled;
END;
$$;

CREATE OR REPLACE FUNCTION public.send_operator_message(
  _conversation_id UUID,
  _content TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _content_clean TEXT := btrim(COALESCE(_content, ''));
  _guard RECORD;
  _message_result RECORD;
BEGIN
  IF char_length(_content_clean) = 0 OR char_length(_content_clean) > 2000 THEN
    RAISE EXCEPTION 'invalid_message_content';
  END IF;

  SELECT * INTO _guard
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);

  SELECT * INTO _message_result
  FROM private.create_operator_message_with_scoring(
    _conversation_id,
    _guard.operator_id,
    _guard.user_id,
    _content_clean,
    jsonb_build_object('source', 'send_operator_message')
  );

  RETURN jsonb_build_object(
    'message', _message_result.message,
    'score_awarded', _message_result.score_awarded,
    'streak_position', _message_result.streak_position,
    'consecutive_message_limit', _message_result.consecutive_message_limit,
    'monthly_points', _message_result.monthly_points,
    'scoring_enabled', _message_result.scoring_enabled,
    'concurrency_mode', _guard.concurrency_mode
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.send_operator_media_message(
  _reservation_id UUID,
  _caption TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _caption_clean TEXT := NULLIF(btrim(COALESCE(_caption, '')), '');
  _conversation_id UUID;
  _asset_id UUID;
  _reservation public.character_media_reservations%ROWTYPE;
  _asset public.character_media_assets%ROWTYPE;
  _guard RECORD;
  _message_result RECORD;
  _attachment public.message_attachments%ROWTYPE;
  _message JSONB;
  _idempotent_result JSONB;
BEGIN
  IF _caption_clean IS NOT NULL AND char_length(_caption_clean) > 1000 THEN
    RAISE EXCEPTION 'invalid_media_caption';
  END IF;

  SELECT r.conversation_id, r.media_asset_id
  INTO _conversation_id, _asset_id
  FROM public.character_media_reservations r
  WHERE r.id = _reservation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_reservation_not_found';
  END IF;

  SELECT * INTO _guard
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);

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

  IF _reservation.operator_id <> _guard.operator_id THEN
    RAISE EXCEPTION 'media_reservation_not_owned';
  END IF;

  IF _reservation.state = 'consumed' THEN
    SELECT to_jsonb(m)
    INTO _message
    FROM public.message_attachments ma
    JOIN public.messages m ON m.id = ma.message_id
    WHERE ma.reservation_id = _reservation.id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'media_reservation_consumed_without_attachment';
    END IF;

    SELECT jsonb_build_object(
      'message', _message,
      'attachment', jsonb_build_object(
        'id', ma.id,
        'message_id', ma.message_id,
        'kind', ma.kind,
        'position', ma.position,
        'caption', ma.caption,
        'metadata', ma.metadata,
        'created_at', ma.created_at
      ),
      'already_sent', true,
      'concurrency_mode', _guard.concurrency_mode
    )
    INTO _idempotent_result
    FROM public.message_attachments ma
    WHERE ma.reservation_id = _reservation.id;

    RETURN _idempotent_result;
  END IF;

  IF _reservation.state = 'released' THEN
    RAISE EXCEPTION 'media_reservation_released';
  ELSIF _reservation.state = 'expired' THEN
    RAISE EXCEPTION 'media_reservation_expired';
  ELSIF _reservation.state <> 'active' THEN
    RAISE EXCEPTION 'media_reservation_not_active';
  END IF;

  IF _asset.status <> 'reserved' THEN
    RAISE EXCEPTION 'media_asset_not_reserved';
  END IF;

  IF _asset.ingest_status <> 'ready' THEN
    RAISE EXCEPTION 'media_asset_not_ready';
  END IF;

  SELECT * INTO _message_result
  FROM private.create_operator_message_with_scoring(
    _conversation_id,
    _guard.operator_id,
    _guard.user_id,
    COALESCE(_caption_clean, '[image]'),
    jsonb_build_object(
      'source', 'send_operator_media_message',
      'attachment_kind', 'image'
    )
  );

  INSERT INTO public.message_attachments (
    message_id,
    media_asset_id,
    reservation_id,
    kind,
    position,
    caption
  )
  VALUES (
    _message_result.message_id,
    _asset.id,
    _reservation.id,
    'image',
    0,
    _caption_clean
  )
  RETURNING * INTO _attachment;

  UPDATE public.character_media_reservations
  SET
    state = 'consumed',
    ended_at = clock_timestamp(),
    ended_by_user_id = _guard.user_id,
    ended_reason = 'sent'
  WHERE id = _reservation.id;

  UPDATE public.character_media_assets
  SET
    status = 'sent',
    updated_by_user_id = _guard.user_id
  WHERE id = _asset.id
    AND status = 'reserved';

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES
    (
      _guard.user_id,
      'character_media_reservation.consumed',
      'character_media_reservation',
      _reservation.id::TEXT,
      jsonb_build_object('media_asset_id', _asset.id, 'message_id', _message_result.message_id)
    ),
    (
      _guard.user_id,
      'message_attachment.created',
      'message_attachment',
      _attachment.id::TEXT,
      jsonb_build_object('message_id', _message_result.message_id, 'kind', 'image')
    );

  RETURN jsonb_build_object(
    'message', _message_result.message,
    'attachment', jsonb_build_object(
      'id', _attachment.id,
      'message_id', _attachment.message_id,
      'kind', _attachment.kind,
      'position', _attachment.position,
      'caption', _attachment.caption,
      'metadata', _attachment.metadata,
      'created_at', _attachment.created_at
    ),
    'already_sent', false,
    'score_awarded', _message_result.score_awarded,
    'streak_position', _message_result.streak_position,
    'consecutive_message_limit', _message_result.consecutive_message_limit,
    'monthly_points', _message_result.monthly_points,
    'scoring_enabled', _message_result.scoring_enabled,
    'concurrency_mode', _guard.concurrency_mode
  );
END;
$$;

REVOKE ALL ON FUNCTION private.assert_operator_can_send_conversation_message(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.create_operator_message_with_scoring(UUID, UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.send_operator_message(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_operator_media_message(UUID, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.send_operator_message(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_operator_media_message(UUID, TEXT) TO authenticated;

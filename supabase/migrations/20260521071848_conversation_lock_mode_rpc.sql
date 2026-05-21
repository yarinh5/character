-- Lock Mode / Warning Mode support for operator conversations.
-- Open mode remains unchanged. send_operator_message enforces lock ownership only when concurrency_mode = lock.

CREATE OR REPLACE FUNCTION private.setting_text(_key TEXT, _default TEXT)
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT CASE
        WHEN jsonb_typeof(value) = 'string' THEN value #>> '{}'
        ELSE value::text
      END
      FROM public.system_settings
      WHERE key = _key
      LIMIT 1
    ),
    _default
  );
$$;

CREATE OR REPLACE FUNCTION public.cleanup_expired_conversation_locks()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count INTEGER := 0;
BEGIN
  UPDATE public.conversation_locks
  SET
    released_at = clock_timestamp(),
    released_by_user_id = NULL,
    release_reason = 'timeout'
  WHERE released_at IS NULL
    AND expires_at <= clock_timestamp();

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END;
$$;

CREATE OR REPLACE FUNCTION public.acquire_conversation_lock(_conversation_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _operator_id UUID;
  _conversation public.conversations%ROWTYPE;
  _timeout_minutes INTEGER := GREATEST(private.setting_int('lock_timeout_minutes', 10), 1);
  _now TIMESTAMPTZ := clock_timestamp();
  _lock public.conversation_locks%ROWTYPE;
  _holder_name TEXT;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM public.cleanup_expired_conversation_locks();

  SELECT id
  INTO _operator_id
  FROM public.operators
  WHERE user_id = _user_id
    AND is_active = true
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations
  WHERE id = _conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF NOT public.is_admin() AND NOT EXISTS (
    SELECT 1
    FROM public.character_operator_assignments coa
    WHERE coa.character_id = _conversation.character_id
      AND coa.operator_id = _operator_id
  ) THEN
    RAISE EXCEPTION 'operator_not_assigned_to_character';
  END IF;

  SELECT *
  INTO _lock
  FROM public.conversation_locks
  WHERE conversation_id = _conversation_id
  FOR UPDATE;

  IF FOUND
    AND _lock.released_at IS NULL
    AND _lock.expires_at > _now
    AND _lock.locked_by_operator_id <> _operator_id THEN
    SELECT full_name INTO _holder_name
    FROM public.operators
    WHERE id = _lock.locked_by_operator_id;

    RETURN jsonb_build_object(
      'acquired', false,
      'lock', to_jsonb(_lock),
      'holder_name', _holder_name,
      'lock_timeout_minutes', _timeout_minutes
    );
  END IF;

  INSERT INTO public.conversation_locks (
    conversation_id,
    locked_by_operator_id,
    locked_by_user_id,
    locked_at,
    last_activity_at,
    expires_at,
    released_at,
    released_by_user_id,
    release_reason,
    metadata
  )
  VALUES (
    _conversation_id,
    _operator_id,
    _user_id,
    _now,
    _now,
    _now + make_interval(mins => _timeout_minutes),
    NULL,
    NULL,
    NULL,
    '{}'::jsonb
  )
  ON CONFLICT (conversation_id)
  DO UPDATE SET
    locked_by_operator_id = EXCLUDED.locked_by_operator_id,
    locked_by_user_id = EXCLUDED.locked_by_user_id,
    locked_at = CASE
      WHEN public.conversation_locks.locked_by_operator_id = EXCLUDED.locked_by_operator_id
           AND public.conversation_locks.released_at IS NULL
      THEN public.conversation_locks.locked_at
      ELSE EXCLUDED.locked_at
    END,
    last_activity_at = EXCLUDED.last_activity_at,
    expires_at = EXCLUDED.expires_at,
    released_at = NULL,
    released_by_user_id = NULL,
    release_reason = NULL
  RETURNING * INTO _lock;

  SELECT full_name INTO _holder_name
  FROM public.operators
  WHERE id = _lock.locked_by_operator_id;

  RETURN jsonb_build_object(
    'acquired', true,
    'lock', to_jsonb(_lock),
    'holder_name', _holder_name,
    'lock_timeout_minutes', _timeout_minutes
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_conversation_lock(_conversation_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _operator_id UUID;
  _lock public.conversation_locks%ROWTYPE;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM public.cleanup_expired_conversation_locks();

  SELECT id
  INTO _operator_id
  FROM public.operators
  WHERE user_id = _user_id
    AND is_active = true
  LIMIT 1;

  SELECT *
  INTO _lock
  FROM public.conversation_locks
  WHERE conversation_id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'reason', 'lock_not_found');
  END IF;

  IF _lock.released_at IS NOT NULL THEN
    RETURN jsonb_build_object('released', false, 'reason', 'already_released', 'lock', to_jsonb(_lock));
  END IF;

  IF NOT public.is_admin() AND (_operator_id IS NULL OR _lock.locked_by_operator_id <> _operator_id) THEN
    RAISE EXCEPTION 'lock_release_not_allowed';
  END IF;

  UPDATE public.conversation_locks
  SET
    released_at = clock_timestamp(),
    released_by_user_id = _user_id,
    release_reason = CASE
      WHEN public.is_admin() AND (_operator_id IS NULL OR locked_by_operator_id <> _operator_id) THEN 'admin_override'
      ELSE 'manual'
    END
  WHERE conversation_id = _conversation_id
  RETURNING * INTO _lock;

  RETURN jsonb_build_object('released', true, 'lock', to_jsonb(_lock));
END;
$$;

CREATE OR REPLACE FUNCTION public.send_operator_message(_conversation_id UUID, _content TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _content_clean TEXT := btrim(COALESCE(_content, ''));
  _operator_id UUID;
  _conversation public.conversations%ROWTYPE;
  _concurrency_mode TEXT := COALESCE(private.setting_text('concurrency_mode', 'open'), 'open');
  _timeout_minutes INTEGER := GREATEST(private.setting_int('lock_timeout_minutes', 10), 1);
  _active_lock public.conversation_locks%ROWTYPE;
  _acquire_result JSONB;
  _scoring_enabled BOOLEAN;
  _limit INTEGER;
  _period_month DATE := date_trunc('month', clock_timestamp())::date;
  _last_client_at TIMESTAMPTZ;
  _streak_position INTEGER := 0;
  _score_awarded INTEGER := 0;
  _monthly_points INTEGER := 0;
  _message public.messages%ROWTYPE;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF char_length(_content_clean) = 0 OR char_length(_content_clean) > 2000 THEN
    RAISE EXCEPTION 'invalid_message_content';
  END IF;

  PERFORM public.cleanup_expired_conversation_locks();

  SELECT id
  INTO _operator_id
  FROM public.operators
  WHERE user_id = _user_id
    AND is_active = true
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations
  WHERE id = _conversation_id
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
    FROM public.conversation_locks
    WHERE conversation_id = _conversation_id
      AND released_at IS NULL
      AND expires_at > clock_timestamp()
    FOR UPDATE;

    IF FOUND AND _active_lock.locked_by_operator_id <> _operator_id THEN
      RAISE EXCEPTION 'conversation_locked_by_other_operator';
    END IF;

    IF NOT FOUND THEN
      _acquire_result := public.acquire_conversation_lock(_conversation_id);
      IF COALESCE((_acquire_result->>'acquired')::boolean, false) IS NOT TRUE THEN
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

  INSERT INTO public.messages (conversation_id, sender_type, sender_id, operator_id, content, created_at)
  VALUES (_conversation_id, 'operator'::public.sender_type, _user_id, _operator_id, _content_clean, clock_timestamp())
  RETURNING * INTO _message;

  _scoring_enabled := private.setting_bool('scoring_enabled', true);
  _limit := GREATEST(private.setting_int('consecutive_message_limit', 3), 0);

  IF _scoring_enabled AND _limit > 0 THEN
    SELECT max(created_at)
    INTO _last_client_at
    FROM public.messages
    WHERE conversation_id = _conversation_id
      AND sender_type = 'client'::public.sender_type;

    SELECT COUNT(*)::integer
    INTO _streak_position
    FROM public.messages
    WHERE conversation_id = _conversation_id
      AND sender_type = 'operator'::public.sender_type
      AND operator_id = _operator_id
      AND created_at > COALESCE(_last_client_at, '-infinity'::timestamptz);

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
        jsonb_build_object('source', 'send_operator_message')
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

  RETURN jsonb_build_object(
    'message', to_jsonb(_message),
    'score_awarded', _score_awarded,
    'streak_position', _streak_position,
    'consecutive_message_limit', _limit,
    'monthly_points', _monthly_points,
    'scoring_enabled', _scoring_enabled,
    'concurrency_mode', _concurrency_mode
  );
END;
$$;

DO $$
BEGIN
  ALTER TABLE public.conversation_locks REPLICA IDENTITY FULL;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'conversation_locks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_locks;
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION public.cleanup_expired_conversation_locks() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.acquire_conversation_lock(UUID) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.release_conversation_lock(UUID) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.send_operator_message(UUID, TEXT) FROM anon, public;

GRANT EXECUTE ON FUNCTION public.cleanup_expired_conversation_locks() TO authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_conversation_lock(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_conversation_lock(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_operator_message(UUID, TEXT) TO authenticated;

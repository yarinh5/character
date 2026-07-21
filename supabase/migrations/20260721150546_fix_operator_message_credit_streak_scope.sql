-- Score and credit eligibility is capped per conversation turn, not per operator.
-- Attribution remains with the operator who created the current message.
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

NOTIFY pgrst, 'reload schema';

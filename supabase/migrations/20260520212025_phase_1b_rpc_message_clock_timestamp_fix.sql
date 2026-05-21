-- Phase 1B fix: RPC-written messages use clock_timestamp() instead of now().
-- Postgres now() is transaction-stable, which can make QA/batched RPC calls share
-- the same created_at and break streak ordering.

CREATE OR REPLACE FUNCTION public.send_client_message(_conversation_id UUID, _content TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _content_clean TEXT := btrim(COALESCE(_content, ''));
  _conversation public.conversations%ROWTYPE;
  _credits_enabled BOOLEAN;
  _balance INTEGER;
  _message public.messages%ROWTYPE;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF char_length(_content_clean) = 0 OR char_length(_content_clean) > 2000 THEN
    RAISE EXCEPTION 'invalid_message_content';
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations
  WHERE id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF _conversation.client_id <> _user_id THEN
    RAISE EXCEPTION 'conversation_access_denied';
  END IF;

  IF _conversation.status = 'closed'::public.conversation_status THEN
    RAISE EXCEPTION 'conversation_closed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.client_conversation_deletions
    WHERE client_id = _user_id
      AND conversation_id = _conversation_id
  ) THEN
    RAISE EXCEPTION 'conversation_deleted_for_client';
  END IF;

  _credits_enabled := private.setting_bool('credits_enabled', true);

  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_user_id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  IF _credits_enabled THEN
    SELECT balance
    INTO _balance
    FROM public.credit_wallets
    WHERE user_id = _user_id
    FOR UPDATE;

    IF COALESCE(_balance, 0) < 1 THEN
      RAISE EXCEPTION 'insufficient_credits';
    END IF;
  END IF;

  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content, created_at)
  VALUES (_conversation_id, 'client'::public.sender_type, _user_id, _content_clean, clock_timestamp())
  RETURNING * INTO _message;

  IF _credits_enabled THEN
    UPDATE public.credit_wallets
    SET balance = balance - 1,
        lifetime_spent = lifetime_spent + 1
    WHERE user_id = _user_id
    RETURNING balance INTO _balance;

    INSERT INTO public.credit_transactions (user_id, amount, balance_after, type, reason, message_id, metadata)
    VALUES (
      _user_id,
      -1,
      _balance,
      'message_spend',
      'Client message spend',
      _message.id,
      jsonb_build_object('conversation_id', _conversation_id)
    );
  ELSE
    SELECT balance INTO _balance
    FROM public.credit_wallets
    WHERE user_id = _user_id;
  END IF;

  RETURN jsonb_build_object(
    'message', to_jsonb(_message),
    'balance', COALESCE(_balance, 0),
    'credits_enabled', _credits_enabled
  );
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
    'scoring_enabled', _scoring_enabled
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.send_client_message(UUID, TEXT) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.send_operator_message(UUID, TEXT) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.send_client_message(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_operator_message(UUID, TEXT) TO authenticated;

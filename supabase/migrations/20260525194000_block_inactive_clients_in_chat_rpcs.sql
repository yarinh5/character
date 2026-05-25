CREATE OR REPLACE FUNCTION private.ensure_active_client(_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.profiles p ON p.user_id = ur.user_id
    WHERE ur.user_id = _user_id
      AND ur.role = 'client'::public.app_role
      AND COALESCE(p.status, 'active') = 'active'
      AND p.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'client_account_inactive';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.ensure_active_client(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.start_or_get_conversation(_character_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _client UUID := auth.uid();
  _conv_id UUID;
  _operator UUID;
  _char_active BOOLEAN;
BEGIN
  IF _client IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  PERFORM private.ensure_active_client(_client);

  SELECT (is_active AND is_visible)
  INTO _char_active
  FROM public.characters
  WHERE id = _character_id;

  IF _char_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Character not available';
  END IF;

  SELECT c.id
  INTO _conv_id
  FROM public.conversations c
  WHERE c.client_id = _client
    AND c.character_id = _character_id
    AND c.status <> 'closed'::public.conversation_status
    AND NOT EXISTS (
      SELECT 1
      FROM public.client_conversation_deletions d
      WHERE d.client_id = _client
        AND d.conversation_id = c.id
    )
  ORDER BY c.created_at DESC
  LIMIT 1;

  IF _conv_id IS NOT NULL THEN
    RETURN _conv_id;
  END IF;

  SELECT o.id
  INTO _operator
  FROM public.operators o
  JOIN public.character_operator_assignments coa ON coa.operator_id = o.id
  WHERE coa.character_id = _character_id
    AND o.is_active = true
  ORDER BY o.availability_status = 'available' DESC,
           (
             SELECT COUNT(*)
             FROM public.conversations c
             WHERE c.assigned_operator_id = o.id
               AND c.status <> 'closed'::public.conversation_status
           ) ASC
  LIMIT 1;

  INSERT INTO public.conversations (client_id, character_id, assigned_operator_id, status)
  VALUES (
    _client,
    _character_id,
    _operator,
    CASE
      WHEN _operator IS NULL THEN 'waiting'::public.conversation_status
      ELSE 'open'::public.conversation_status
    END
  )
  RETURNING id INTO _conv_id;

  RETURN _conv_id;
END;
$$;

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

  PERFORM private.ensure_active_client(_user_id);

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

REVOKE EXECUTE ON FUNCTION public.start_or_get_conversation(UUID) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.start_or_get_conversation(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.send_client_message(UUID, TEXT) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.send_client_message(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

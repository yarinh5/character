-- Preserve the WP10 access block on ordinary status and client text writes.
CREATE OR REPLACE FUNCTION public.admin_set_conversation_status(_conversation_id uuid, _status conversation_status)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  _admin_id UUID := auth.uid();
  _previous_status public.conversation_status;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _admin_id IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF _conversation_id IS NULL THEN
    RAISE EXCEPTION 'conversation_required';
  END IF;

  IF _status IS NULL THEN
    RAISE EXCEPTION 'status_required';
  END IF;

  SELECT status
  INTO _previous_status
  FROM public.conversations
  WHERE id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF _status <> 'closed'::public.conversation_status
     AND private.conversation_deletion_blocks_access(_conversation_id) THEN
    RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE = '42501';
  END IF;

  UPDATE public.conversations
  SET status = _status
  WHERE id = _conversation_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'conversation.status_changed',
    'conversation',
    _conversation_id::TEXT,
    jsonb_build_object('previous_status', _previous_status, 'status', _status)
  );

  RETURN jsonb_build_object('conversation_id', _conversation_id, 'status', _status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.send_client_message(_conversation_id uuid, _content text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _content_clean text := btrim(COALESCE(_content, ''));
  _conversation public.conversations%rowtype;
  _credits_enabled boolean;
  _price integer := GREATEST(private.setting_int('client_text_credit_price', 10), 0);
  _balance integer;
  _message public.messages%rowtype;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM private.ensure_active_client(_user_id);
  IF char_length(_content_clean) = 0 OR char_length(_content_clean) > 2000 THEN
    RAISE EXCEPTION 'invalid_message_content';
  END IF;
  SELECT * INTO _conversation FROM public.conversations
  WHERE id = _conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  IF _conversation.client_id <> _user_id THEN RAISE EXCEPTION 'conversation_access_denied'; END IF;
  IF _conversation.status = 'closed'::public.conversation_status THEN RAISE EXCEPTION 'conversation_closed'; END IF;
  IF private.conversation_deletion_blocks_access(_conversation_id) THEN
    RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE = '42501';
  END IF;
  IF _conversation.client_hidden_at IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.client_conversation_deletions deletion
    WHERE deletion.client_id = _user_id AND deletion.conversation_id = _conversation_id
  ) THEN RAISE EXCEPTION 'conversation_deleted_for_client'; END IF;

  _credits_enabled := private.setting_bool('credits_enabled', true);
  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_user_id, 0, 0, 0) ON CONFLICT (user_id) DO NOTHING;
  SELECT balance INTO _balance FROM public.credit_wallets
  WHERE user_id = _user_id FOR UPDATE;
  IF _credits_enabled AND COALESCE(_balance, 0) < _price THEN RAISE EXCEPTION 'insufficient_credits'; END IF;

  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content, created_at)
  VALUES (_conversation_id, 'client'::public.sender_type, _user_id, _content_clean, clock_timestamp())
  RETURNING * INTO _message;

  IF _credits_enabled AND _price > 0 THEN
    UPDATE public.credit_wallets
    SET balance = balance - _price, lifetime_spent = lifetime_spent + _price
    WHERE user_id = _user_id RETURNING balance INTO _balance;
    INSERT INTO public.credit_transactions (
      user_id, amount, balance_after, type, reason, message_id, metadata
    ) VALUES (
      _user_id, -_price, _balance, 'message_spend', 'Client text message', _message.id,
      jsonb_build_object('conversation_id', _conversation_id, 'price_version', 'wp07-v1')
    );
  END IF;

  RETURN jsonb_build_object(
    'message', to_jsonb(_message), 'balance', COALESCE(_balance, 0),
    'credits_enabled', _credits_enabled, 'price_credits', CASE WHEN _credits_enabled THEN _price ELSE 0 END
  );
END;
$$;

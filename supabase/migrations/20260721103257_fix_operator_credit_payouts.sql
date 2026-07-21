-- Align paid sticker and client-message credit payouts with the operator who currently owns the conversation.
-- Priority: assigned_operator_id, then active conversation lock, then latest active operator message.

CREATE OR REPLACE FUNCTION private.resolve_conversation_credit_recipient_operator(
  _conversation_id UUID
)
RETURNS TABLE (
  payout_operator_id UUID,
  payout_user_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT conversation.assigned_operator_id, operator.user_id
  FROM public.conversations conversation
  JOIN public.operators operator ON operator.id = conversation.assigned_operator_id
  WHERE conversation.id = _conversation_id
    AND conversation.assigned_operator_id IS NOT NULL
    AND operator.is_active = TRUE
    AND operator.deleted_at IS NULL
  LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT conversation_lock.locked_by_operator_id, operator.user_id
  FROM public.conversation_locks conversation_lock
  JOIN public.operators operator ON operator.id = conversation_lock.locked_by_operator_id
  WHERE conversation_lock.conversation_id = _conversation_id
    AND conversation_lock.released_at IS NULL
    AND conversation_lock.expires_at > clock_timestamp()
    AND operator.is_active = TRUE
    AND operator.deleted_at IS NULL
  LIMIT 1;

  IF FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT message.operator_id, operator.user_id
  FROM public.messages message
  JOIN public.operators operator ON operator.id = message.operator_id
  WHERE message.conversation_id = _conversation_id
    AND message.sender_type = 'operator'::public.sender_type
    AND message.operator_id IS NOT NULL
    AND operator.is_active = TRUE
    AND operator.deleted_at IS NULL
  ORDER BY message.created_at DESC, message.id DESC
  LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION private.resolve_paid_sticker_payout_operator(
  _conversation_id UUID
)
RETURNS TABLE (
  operator_id UUID,
  user_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    recipient.payout_operator_id,
    recipient.payout_user_id
  FROM private.resolve_conversation_credit_recipient_operator(_conversation_id) recipient;
END;
$$;

ALTER TABLE public.credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_type_check;

ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_type_check
  CHECK (type = ANY (ARRAY[
    'signup_bonus'::TEXT,
    'message_spend'::TEXT,
    'message_payout'::TEXT,
    'admin_adjustment'::TEXT,
    'package_purchase'::TEXT,
    'reset_grant'::TEXT,
    'migration_backfill'::TEXT,
    'locked_image_unlock'::TEXT,
    'locked_image_refund'::TEXT,
    'sticker_spend'::TEXT,
    'sticker_payout'::TEXT,
    'sticker_refund'::TEXT
  ]));

CREATE OR REPLACE FUNCTION public.send_client_message(_conversation_id UUID, _content TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _content_clean TEXT := btrim(COALESCE(_content, ''));
  _conversation public.conversations%ROWTYPE;
  _credits_enabled BOOLEAN;
  _balance INTEGER;
  _message public.messages%ROWTYPE;
  _payout_operator_id UUID;
  _payout_user_id UUID;
  _payout_balance_after INTEGER;
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

  IF _conversation.client_hidden_at IS NOT NULL THEN
    RAISE EXCEPTION 'conversation_deleted_for_client';
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

  SELECT recipient.payout_operator_id, recipient.payout_user_id
  INTO _payout_operator_id, _payout_user_id
  FROM private.resolve_conversation_credit_recipient_operator(_conversation_id) recipient;

  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_user_id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  IF _credits_enabled AND _payout_user_id IS NOT NULL AND _payout_user_id <> _user_id THEN
    INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
    VALUES (_payout_user_id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  IF _credits_enabled THEN
    IF _payout_user_id IS NOT NULL AND _payout_user_id <> _user_id THEN
      IF _user_id < _payout_user_id THEN
        SELECT balance
        INTO _balance
        FROM public.credit_wallets
        WHERE user_id = _user_id
        FOR UPDATE;

        PERFORM 1
        FROM public.credit_wallets
        WHERE user_id = _payout_user_id
        FOR UPDATE;
      ELSE
        PERFORM 1
        FROM public.credit_wallets
        WHERE user_id = _payout_user_id
        FOR UPDATE;

        SELECT balance
        INTO _balance
        FROM public.credit_wallets
        WHERE user_id = _user_id
        FOR UPDATE;
      END IF;
    ELSE
      SELECT balance
      INTO _balance
      FROM public.credit_wallets
      WHERE user_id = _user_id
      FOR UPDATE;
    END IF;

    IF COALESCE(_balance, 0) < 1 THEN
      RAISE EXCEPTION 'insufficient_credits';
    END IF;
  END IF;

  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content, created_at)
  VALUES (_conversation_id, 'client'::public.sender_type, _user_id, _content_clean, clock_timestamp())
  RETURNING * INTO _message;

  IF _credits_enabled THEN
    UPDATE public.credit_wallets
    SET
      balance = balance - 1,
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
      jsonb_build_object(
        'conversation_id', _conversation_id,
        'payout_operator_id', _payout_operator_id
      )
    );

    IF _payout_user_id IS NOT NULL AND _payout_user_id <> _user_id THEN
      UPDATE public.credit_wallets
      SET
        balance = balance + 1,
        lifetime_earned = lifetime_earned + 1
      WHERE user_id = _payout_user_id
      RETURNING balance INTO _payout_balance_after;

      INSERT INTO public.credit_transactions (user_id, amount, balance_after, type, reason, message_id, metadata)
      VALUES (
        _payout_user_id,
        1,
        _payout_balance_after,
        'message_payout',
        'Client message payout',
        _message.id,
        jsonb_build_object(
          'conversation_id', _conversation_id,
          'payout_operator_id', _payout_operator_id,
          'source', 'send_client_message'
        )
      );
    END IF;
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

-- Repair existing paid sticker payouts that were assigned to the latest operator message
-- instead of the current assigned conversation operator.
DO $$
DECLARE
  _row RECORD;
  _old_balance_after INTEGER;
  _new_balance_after INTEGER;
BEGIN
  FOR _row IN
    SELECT
      message_sticker.id AS message_sticker_id,
      message_sticker.message_id,
      message_sticker.payout_operator_id AS old_operator_id,
      old_operator.user_id AS old_user_id,
      conversation.assigned_operator_id AS new_operator_id,
      new_operator.user_id AS new_user_id,
      payout_transaction.id AS payout_transaction_id,
      payout_transaction.amount AS payout_amount
    FROM public.message_stickers message_sticker
    JOIN public.messages message ON message.id = message_sticker.message_id
    JOIN public.conversations conversation ON conversation.id = message.conversation_id
    JOIN public.operators new_operator ON new_operator.id = conversation.assigned_operator_id
    JOIN public.credit_transactions payout_transaction ON payout_transaction.id = message_sticker.payout_transaction_id
    LEFT JOIN public.operators old_operator ON old_operator.id = message_sticker.payout_operator_id
    WHERE message_sticker.price_credits_snapshot > 0
      AND message_sticker.charged_transaction_id IS NOT NULL
      AND message_sticker.payout_transaction_id IS NOT NULL
      AND conversation.assigned_operator_id IS NOT NULL
      AND message_sticker.payout_operator_id IS DISTINCT FROM conversation.assigned_operator_id
      AND new_operator.is_active = TRUE
      AND new_operator.deleted_at IS NULL
      AND payout_transaction.type = 'sticker_payout'
      AND payout_transaction.amount > 0
  LOOP
    IF _row.old_user_id IS NOT NULL THEN
      UPDATE public.credit_wallets
      SET
        balance = balance - _row.payout_amount,
        lifetime_earned = GREATEST(lifetime_earned - _row.payout_amount, 0)
      WHERE user_id = _row.old_user_id
      RETURNING balance INTO _old_balance_after;
    END IF;

    INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
    VALUES (_row.new_user_id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    UPDATE public.credit_wallets
    SET
      balance = balance + _row.payout_amount,
      lifetime_earned = lifetime_earned + _row.payout_amount
    WHERE user_id = _row.new_user_id
    RETURNING balance INTO _new_balance_after;

    UPDATE public.credit_transactions
    SET
      user_id = _row.new_user_id,
      balance_after = _new_balance_after,
      metadata = COALESCE(metadata, '{}'::JSONB)
        || jsonb_build_object(
          'payout_operator_id', _row.new_operator_id,
          'payout_reassigned_from_operator_id', _row.old_operator_id,
          'payout_reassigned_from_user_id', _row.old_user_id,
          'payout_reassigned_at', clock_timestamp(),
          'source', 'fix_operator_credit_payouts'
        )
    WHERE id = _row.payout_transaction_id;

    UPDATE public.message_stickers
    SET payout_operator_id = _row.new_operator_id
    WHERE id = _row.message_sticker_id;

    UPDATE private.sticker_send_attempts
    SET
      payout_operator_id = _row.new_operator_id,
      updated_at = clock_timestamp()
    WHERE message_id = _row.message_id
      AND payout_transaction_id = _row.payout_transaction_id;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION private.resolve_conversation_credit_recipient_operator(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.resolve_paid_sticker_payout_operator(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.send_client_message(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_client_message(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

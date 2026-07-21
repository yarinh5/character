-- Paid Stickers: catalog pricing, atomic client charge/payout, and immutable send snapshots.
-- No feature flag, Storage, or Edge Function changes are included here.

ALTER TABLE public.stickers
  ADD COLUMN price_credits INTEGER NOT NULL DEFAULT 0
    CHECK (price_credits >= 0);

ALTER TABLE public.message_stickers
  ADD COLUMN price_credits_snapshot INTEGER NOT NULL DEFAULT 0
    CHECK (price_credits_snapshot >= 0),
  ADD COLUMN payer_client_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN charged_transaction_id UUID UNIQUE REFERENCES public.credit_transactions(id) ON DELETE RESTRICT,
  ADD COLUMN payout_operator_id UUID REFERENCES public.operators(id) ON DELETE RESTRICT,
  ADD COLUMN payout_transaction_id UUID UNIQUE REFERENCES public.credit_transactions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT message_stickers_payment_shape_check CHECK (
    (payer_client_id IS NULL
      AND charged_transaction_id IS NULL
      AND payout_operator_id IS NULL
      AND payout_transaction_id IS NULL)
    OR
    (price_credits_snapshot > 0
      AND payer_client_id IS NOT NULL
      AND charged_transaction_id IS NOT NULL
      AND payout_operator_id IS NOT NULL
      AND payout_transaction_id IS NOT NULL)
  );

CREATE INDEX message_stickers_payout_operator_created_idx
  ON public.message_stickers (payout_operator_id, created_at DESC)
  WHERE payout_operator_id IS NOT NULL;

ALTER TABLE private.sticker_send_attempts
  ADD COLUMN price_credits_snapshot INTEGER NOT NULL DEFAULT 0
    CHECK (price_credits_snapshot >= 0),
  ADD COLUMN charged_transaction_id UUID UNIQUE REFERENCES public.credit_transactions(id) ON DELETE RESTRICT,
  ADD COLUMN payout_operator_id UUID REFERENCES public.operators(id) ON DELETE RESTRICT,
  ADD COLUMN payout_transaction_id UUID UNIQUE REFERENCES public.credit_transactions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT sticker_send_attempts_payment_shape_check CHECK (
    status <> 'succeeded'
    OR (
      (charged_transaction_id IS NULL
        AND payout_operator_id IS NULL
        AND payout_transaction_id IS NULL)
      OR
      (price_credits_snapshot > 0
        AND charged_transaction_id IS NOT NULL
        AND payout_operator_id IS NOT NULL
        AND payout_transaction_id IS NOT NULL)
    )
  );

CREATE INDEX sticker_send_attempts_payout_operator_created_idx
  ON private.sticker_send_attempts (payout_operator_id, created_at DESC)
  WHERE payout_operator_id IS NOT NULL;

ALTER TABLE public.credit_transactions
  DROP CONSTRAINT credit_transactions_type_check,
  ADD CONSTRAINT credit_transactions_type_check
    CHECK (type = ANY (ARRAY[
      'signup_bonus'::TEXT,
      'message_spend'::TEXT,
      'admin_adjustment'::TEXT,
      'package_purchase'::TEXT,
      'reset_grant'::TEXT,
      'migration_backfill'::TEXT,
      'locked_image_unlock'::TEXT,
      'locked_image_refund'::TEXT,
      'gift_spend'::TEXT,
      'gift_refund'::TEXT,
      'gift_compensation'::TEXT,
      'sticker_spend'::TEXT,
      'sticker_payout'::TEXT,
      'sticker_refund'::TEXT
    ]));

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
  SELECT lock.locked_by_operator_id, operator.user_id
  INTO operator_id, user_id
  FROM public.conversation_locks lock
  JOIN public.operators operator ON operator.id = lock.locked_by_operator_id
  WHERE lock.conversation_id = _conversation_id
    AND lock.released_at IS NULL
    AND lock.expires_at > clock_timestamp()
    AND operator.is_active = TRUE
    AND operator.deleted_at IS NULL;

  IF FOUND THEN
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT message.operator_id, operator.user_id
  INTO operator_id, user_id
  FROM public.messages message
  JOIN public.operators operator ON operator.id = message.operator_id
  WHERE message.conversation_id = _conversation_id
    AND message.sender_type = 'operator'::public.sender_type
    AND message.operator_id IS NOT NULL
    AND operator.is_active = TRUE
    AND operator.deleted_at IS NULL
  ORDER BY message.created_at DESC, message.id DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN NEXT;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.get_admin_sticker_catalog();

CREATE OR REPLACE FUNCTION public.get_admin_sticker_catalog()
RETURNS TABLE (
  id UUID,
  collection_id UUID,
  collection_name TEXT,
  collection_slug TEXT,
  character_id UUID,
  name TEXT,
  slug TEXT,
  is_active BOOLEAN,
  collection_is_active BOOLEAN,
  ingest_status TEXT,
  width INTEGER,
  height INTEGER,
  byte_size INTEGER,
  price_credits INTEGER,
  failure_code TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  processing_started_at TIMESTAMPTZ,
  is_processing_stuck BOOLEAN,
  deletion_started_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  RETURN QUERY
  SELECT
    sticker.id,
    collection.id,
    collection.name,
    collection.slug,
    collection.character_id,
    sticker.name,
    sticker.slug,
    sticker.is_active,
    collection.is_active,
    sticker.ingest_status,
    sticker.width,
    sticker.height,
    sticker.byte_size,
    sticker.price_credits,
    sticker.failure_code,
    sticker.created_at,
    sticker.updated_at,
    sticker.processing_started_at,
    sticker.ingest_status = 'processing'
      AND sticker.processing_started_at <= clock_timestamp() - INTERVAL '10 minutes',
    sticker.deletion_started_at
  FROM public.stickers sticker
  JOIN public.sticker_collections collection ON collection.id = sticker.collection_id
  ORDER BY collection.sort_order, collection.name, sticker.sort_order, sticker.name, sticker.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_sticker_price(
  _sticker_id UUID,
  _price_credits INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF _price_credits IS NULL OR _price_credits < 0 THEN
    RAISE EXCEPTION 'sticker_price_invalid';
  END IF;

  UPDATE public.stickers
  SET
    price_credits = _price_credits,
    updated_at = clock_timestamp(),
    updated_by_user_id = auth.uid()
  WHERE id = _sticker_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sticker_not_found';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.get_conversation_stickers(UUID);

CREATE OR REPLACE FUNCTION public.get_conversation_stickers(
  _conversation_id UUID
)
RETURNS TABLE (
  sticker_id UUID,
  collection_id UUID,
  name TEXT,
  collection_name TEXT,
  scope TEXT,
  sort_order INTEGER,
  price_credits INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _conversation public.conversations%ROWTYPE;
  _operator_id UUID;
  _is_client BOOLEAN := FALSE;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF private.setting_bool('stickers_enabled', false) IS NOT TRUE THEN
    RAISE EXCEPTION 'stickers_disabled';
  END IF;

  SELECT * INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF _conversation.status = 'closed'::public.conversation_status THEN
    RAISE EXCEPTION 'conversation_closed';
  END IF;

  IF _conversation.client_id = _user_id THEN
    _is_client := TRUE;
    PERFORM private.ensure_active_client(_user_id);
    IF _conversation.client_hidden_at IS NOT NULL OR EXISTS (
      SELECT 1
      FROM public.client_conversation_deletions deletion
      WHERE deletion.client_id = _user_id
        AND deletion.conversation_id = _conversation_id
    ) THEN
      RAISE EXCEPTION 'conversation_deleted_for_client';
    END IF;
  ELSE
    SELECT operator.id INTO _operator_id
    FROM public.operators operator
    WHERE operator.user_id = _user_id
      AND operator.is_active = TRUE
      AND operator.deleted_at IS NULL
    LIMIT 1;

    IF _operator_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.character_operator_assignments assignment
      WHERE assignment.character_id = _conversation.character_id
        AND assignment.operator_id = _operator_id
    ) THEN
      RAISE EXCEPTION 'conversation_access_denied';
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    sticker.id,
    collection.id,
    sticker.name,
    collection.name,
    CASE WHEN collection.character_id IS NULL THEN 'global' ELSE 'character' END,
    sticker.sort_order,
    CASE WHEN _is_client THEN sticker.price_credits ELSE NULL::INTEGER END
  FROM public.stickers sticker
  JOIN public.sticker_collections collection ON collection.id = sticker.collection_id
  WHERE sticker.is_active = TRUE
    AND sticker.ingest_status = 'ready'
    AND collection.is_active = TRUE
    AND (collection.character_id IS NULL OR collection.character_id = _conversation.character_id)
  ORDER BY collection.sort_order, collection.name, sticker.sort_order, sticker.name, sticker.id;
END;
$$;

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
  _charge public.credit_transactions%ROWTYPE;
  _conversation_character_id UUID;
  _payout_operator_id UUID;
  _payout_user_id UUID;
  _client_balance INTEGER;
  _client_balance_after INTEGER;
  _payout_balance_after INTEGER;
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
  ELSIF _actor_kind = 'admin' THEN
    SELECT * INTO _operator_guard
    FROM private.assert_admin_can_send_conversation_message(_conversation_id);
  ELSE
    RAISE EXCEPTION 'invalid_sticker_sender';
  END IF;

  SELECT conversation.character_id INTO _conversation_character_id
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id;

  SELECT * INTO _attempt
  FROM private.sticker_send_attempts attempt
  WHERE attempt.actor_user_id = _user_id
    AND attempt.idempotency_key = _idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF _attempt.request_fingerprint <> _fingerprint THEN
      RAISE EXCEPTION 'sticker_idempotency_key_reused';
    END IF;

    IF _attempt.status <> 'succeeded' OR _attempt.message_id IS NULL THEN
      RAISE EXCEPTION 'sticker_send_in_progress';
    END IF;

    SELECT * INTO _message FROM public.messages message WHERE message.id = _attempt.message_id;
    SELECT * INTO _message_sticker FROM public.message_stickers message_sticker
    WHERE message_sticker.message_id = _attempt.message_id;

    IF _attempt.price_credits_snapshot > 0 THEN
      SELECT * INTO _charge
      FROM public.credit_transactions transaction
      WHERE transaction.id = _attempt.charged_transaction_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'sticker_attempt_payment_invariant_failed';
      END IF;
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
      'balance', CASE WHEN _actor_kind = 'client' AND _attempt.price_credits_snapshot > 0 THEN _charge.balance_after ELSE NULL END,
      'already_sent', TRUE
    );
  END IF;

  IF private.setting_bool('stickers_enabled', false) IS NOT TRUE THEN
    RAISE EXCEPTION 'stickers_disabled';
  END IF;

  SELECT
    sticker.id,
    sticker.name AS sticker_name,
    sticker.price_credits,
    collection.name AS collection_name
  INTO _sticker
  FROM public.stickers sticker
  JOIN public.sticker_collections collection ON collection.id = sticker.collection_id
  WHERE sticker.id = _sticker_id
    AND sticker.is_active = TRUE
    AND sticker.ingest_status = 'ready'
    AND collection.is_active = TRUE
    AND (collection.character_id IS NULL OR collection.character_id = _conversation_character_id)
  FOR UPDATE OF sticker;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sticker_not_available';
  END IF;

  IF _actor_kind = 'client' AND _sticker.price_credits > 0 THEN
    SELECT resolved.operator_id, resolved.user_id
    INTO _payout_operator_id, _payout_user_id
    FROM private.resolve_paid_sticker_payout_operator(_conversation_id) resolved;

    IF _payout_operator_id IS NULL OR _payout_user_id IS NULL THEN
      RAISE EXCEPTION 'paid_sticker_requires_operator_context';
    END IF;

    IF _payout_user_id = _client_guard.user_id THEN
      RAISE EXCEPTION 'paid_sticker_invalid_payout_operator';
    END IF;
  END IF;

  INSERT INTO private.sticker_send_attempts (
    actor_user_id,
    actor_kind,
    conversation_id,
    sticker_id,
    idempotency_key,
    request_fingerprint,
    price_credits_snapshot
  )
  VALUES (
    _user_id,
    _actor_kind,
    _conversation_id,
    _sticker.id,
    _idempotency_key,
    _fingerprint,
    _sticker.price_credits
  )
  ON CONFLICT (actor_user_id, idempotency_key) DO NOTHING
  RETURNING * INTO _attempt;

  IF NOT FOUND THEN
    SELECT * INTO _attempt
    FROM private.sticker_send_attempts attempt
    WHERE attempt.actor_user_id = _user_id
      AND attempt.idempotency_key = _idempotency_key
    FOR UPDATE;

    IF _attempt.request_fingerprint <> _fingerprint THEN
      RAISE EXCEPTION 'sticker_idempotency_key_reused';
    END IF;

    IF _attempt.status <> 'succeeded' OR _attempt.message_id IS NULL THEN
      RAISE EXCEPTION 'sticker_send_in_progress';
    END IF;

    SELECT * INTO _message FROM public.messages message WHERE message.id = _attempt.message_id;
    SELECT * INTO _message_sticker FROM public.message_stickers message_sticker
    WHERE message_sticker.message_id = _attempt.message_id;

    IF _attempt.price_credits_snapshot > 0 THEN
      SELECT * INTO _charge FROM public.credit_transactions transaction
      WHERE transaction.id = _attempt.charged_transaction_id;
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
      'balance', CASE WHEN _actor_kind = 'client' AND _attempt.price_credits_snapshot > 0 THEN _charge.balance_after ELSE NULL END,
      'already_sent', TRUE
    );
  END IF;

  PERFORM private.consume_sticker_send_rate_limit(_conversation_id, _user_id, _actor_kind);

  IF _actor_kind = 'client' AND _sticker.price_credits > 0 THEN
    INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
    VALUES
      (_client_guard.user_id, 0, 0, 0),
      (_payout_user_id, 0, 0, 0)
    ON CONFLICT (user_id) DO NOTHING;

    IF _client_guard.user_id < _payout_user_id THEN
      SELECT wallet.balance INTO _client_balance
      FROM public.credit_wallets wallet
      WHERE wallet.user_id = _client_guard.user_id
      FOR UPDATE;

      PERFORM 1
      FROM public.credit_wallets wallet
      WHERE wallet.user_id = _payout_user_id
      FOR UPDATE;
    ELSE
      PERFORM 1
      FROM public.credit_wallets wallet
      WHERE wallet.user_id = _payout_user_id
      FOR UPDATE;

      SELECT wallet.balance INTO _client_balance
      FROM public.credit_wallets wallet
      WHERE wallet.user_id = _client_guard.user_id
      FOR UPDATE;
    END IF;

    IF COALESCE(_client_balance, 0) < _sticker.price_credits THEN
      RAISE EXCEPTION 'insufficient_credits';
    END IF;

    UPDATE public.credit_wallets
    SET
      balance = balance - _sticker.price_credits,
      lifetime_spent = lifetime_spent + _sticker.price_credits
    WHERE user_id = _client_guard.user_id
    RETURNING balance INTO _client_balance_after;

    UPDATE public.credit_wallets
    SET
      balance = balance + _sticker.price_credits,
      lifetime_earned = lifetime_earned + _sticker.price_credits
    WHERE user_id = _payout_user_id
    RETURNING balance INTO _payout_balance_after;
  END IF;

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
    CASE WHEN _actor_kind = 'client' THEN 'client'::public.sender_type ELSE 'operator'::public.sender_type END,
    _user_id,
    CASE WHEN _actor_kind = 'client' THEN NULL ELSE _operator_guard.operator_id END,
    '[sticker]',
    clock_timestamp()
  )
  RETURNING * INTO _message;

  IF _actor_kind = 'client' AND _sticker.price_credits > 0 THEN
    INSERT INTO public.credit_transactions (
      user_id,
      amount,
      balance_after,
      type,
      reason,
      message_id,
      metadata
    )
    VALUES (
      _client_guard.user_id,
      -_sticker.price_credits,
      _client_balance_after,
      'sticker_spend',
      'paid_sticker_send',
      _message.id,
      jsonb_build_object(
        'sticker_id', _sticker.id,
        'price_credits_snapshot', _sticker.price_credits,
        'payout_operator_id', _payout_operator_id,
        'source', 'send_client_sticker_message'
      )
    )
    RETURNING * INTO _charge;

    INSERT INTO public.credit_transactions (
      user_id,
      amount,
      balance_after,
      type,
      reason,
      message_id,
      metadata
    )
    VALUES (
      _payout_user_id,
      _sticker.price_credits,
      _payout_balance_after,
      'sticker_payout',
      'paid_sticker_payout',
      _message.id,
      jsonb_build_object(
        'sticker_id', _sticker.id,
        'price_credits_snapshot', _sticker.price_credits,
        'payer_client_id', _client_guard.user_id,
        'payout_operator_id', _payout_operator_id,
        'source', 'send_client_sticker_message'
      )
    )
    RETURNING id INTO _attempt.payout_transaction_id;
  END IF;

  INSERT INTO public.message_stickers (
    message_id,
    sticker_id,
    sticker_name_snapshot,
    collection_name_snapshot,
    price_credits_snapshot,
    payer_client_id,
    charged_transaction_id,
    payout_operator_id,
    payout_transaction_id
  )
  VALUES (
    _message.id,
    _sticker.id,
    _sticker.sticker_name,
    _sticker.collection_name,
    _sticker.price_credits,
    CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _client_guard.user_id ELSE NULL END,
    CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _charge.id ELSE NULL END,
    CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _payout_operator_id ELSE NULL END,
    CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _attempt.payout_transaction_id ELSE NULL END
  )
  RETURNING * INTO _message_sticker;

  UPDATE private.sticker_send_attempts
  SET
    message_id = _message.id,
    charged_transaction_id = CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _charge.id ELSE NULL END,
    payout_operator_id = CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _payout_operator_id ELSE NULL END,
    payout_transaction_id = CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _attempt.payout_transaction_id ELSE NULL END,
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
    'balance', CASE WHEN _actor_kind = 'client' AND _sticker.price_credits > 0 THEN _client_balance_after ELSE NULL END,
    'already_sent', FALSE
  );
END;
$$;

REVOKE ALL ON FUNCTION private.resolve_paid_sticker_payout_operator(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_sticker_price(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_sticker_price(UUID, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Phase 3D-A: Gifts financial foundation only. No UI, Storage, or Edge Functions.

INSERT INTO public.system_settings (key, value)
VALUES ('gifts_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE public.gift_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  character_id UUID REFERENCES public.characters(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX gift_collections_active_character_sort_idx
  ON public.gift_collections (character_id, sort_order, created_at)
  WHERE is_active = true;

CREATE TABLE public.gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES public.gift_collections(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  price_credits INTEGER NOT NULL CHECK (price_credits > 0),
  is_active BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX gifts_active_collection_sort_idx
  ON public.gifts (collection_id, sort_order, created_at)
  WHERE is_active = true;

ALTER TABLE public.credit_transactions
  DROP CONSTRAINT credit_transactions_type_check,
  ADD CONSTRAINT credit_transactions_type_check
    CHECK (type = ANY (ARRAY[
      'signup_bonus'::text,
      'message_spend'::text,
      'admin_adjustment'::text,
      'package_purchase'::text,
      'reset_grant'::text,
      'migration_backfill'::text,
      'locked_image_unlock'::text,
      'locked_image_refund'::text,
      'gift_spend'::text,
      'gift_refund'::text,
      'gift_compensation'::text
    ]));

CREATE TABLE public.message_gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
  gift_id UUID NOT NULL REFERENCES public.gifts(id) ON DELETE RESTRICT,
  gift_name_snapshot TEXT NOT NULL CHECK (char_length(btrim(gift_name_snapshot)) BETWEEN 1 AND 120),
  collection_name_snapshot TEXT NOT NULL CHECK (char_length(btrim(collection_name_snapshot)) BETWEEN 1 AND 120),
  price_credits_snapshot INTEGER NOT NULL CHECK (price_credits_snapshot > 0),
  charged_transaction_id UUID NOT NULL UNIQUE REFERENCES public.credit_transactions(id) ON DELETE RESTRICT,
  refund_transaction_id UUID UNIQUE REFERENCES public.credit_transactions(id) ON DELETE RESTRICT,
  compensation_transaction_id UUID UNIQUE REFERENCES public.credit_transactions(id) ON DELETE RESTRICT,
  refunded_at TIMESTAMPTZ,
  refund_reason TEXT,
  compensated_at TIMESTAMPTZ,
  compensation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (refund_transaction_id IS NULL AND refunded_at IS NULL AND refund_reason IS NULL)
    OR (refund_transaction_id IS NOT NULL AND refunded_at IS NOT NULL AND char_length(btrim(refund_reason)) >= 3)
  ),
  CHECK (
    (compensation_transaction_id IS NULL AND compensated_at IS NULL AND compensation_reason IS NULL)
    OR (compensation_transaction_id IS NOT NULL AND compensated_at IS NOT NULL AND char_length(btrim(compensation_reason)) >= 3)
  )
);

CREATE INDEX message_gifts_gift_created_idx
  ON public.message_gifts (gift_id, created_at DESC);

CREATE TABLE private.gift_send_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  gift_id UUID NOT NULL REFERENCES public.gifts(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded')),
  message_id UUID UNIQUE REFERENCES public.messages(id) ON DELETE SET NULL,
  charged_transaction_id UUID UNIQUE REFERENCES public.credit_transactions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (client_id, idempotency_key)
);

CREATE INDEX gift_send_attempts_client_created_idx
  ON private.gift_send_attempts (client_id, created_at DESC);

CREATE TABLE private.conversation_gift_rate_limits (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_sent_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (conversation_id, client_id)
);

ALTER TABLE public.gift_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_gifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.gift_send_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.conversation_gift_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.gift_collections FROM anon, authenticated;
REVOKE ALL ON TABLE public.gifts FROM anon, authenticated;
REVOKE ALL ON TABLE public.message_gifts FROM anon, authenticated;
GRANT SELECT (id, message_id, gift_id, gift_name_snapshot, collection_name_snapshot, created_at)
  ON TABLE public.message_gifts TO authenticated;

CREATE POLICY "Clients view gifts in own conversations"
  ON public.message_gifts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.messages message
      WHERE message.id = message_id
        AND public.is_conversation_client(message.conversation_id)
    )
  );

CREATE POLICY "Operators view gifts in assigned conversations"
  ON public.message_gifts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.messages message
      WHERE message.id = message_id
        AND public.is_conversation_operator(message.conversation_id)
    )
  );

CREATE POLICY "Admins view all message gifts"
  ON public.message_gifts
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

CREATE OR REPLACE FUNCTION private.assert_client_can_send_gift_message(
  _conversation_id UUID
)
RETURNS TABLE (
  user_id UUID,
  character_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _conversation public.conversations%ROWTYPE;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM private.ensure_active_client(_user_id);

  SELECT *
  INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
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

  IF _conversation.client_hidden_at IS NOT NULL OR EXISTS (
    SELECT 1
    FROM public.client_conversation_deletions deletion
    WHERE deletion.client_id = _user_id
      AND deletion.conversation_id = _conversation_id
  ) THEN
    RAISE EXCEPTION 'conversation_deleted_for_client';
  END IF;

  RETURN QUERY SELECT _user_id, _conversation.character_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.consume_client_gift_rate_limit(
  _conversation_id UUID,
  _client_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _accepted_at TIMESTAMPTZ;
BEGIN
  INSERT INTO private.conversation_gift_rate_limits (
    conversation_id,
    client_id,
    last_sent_at
  )
  VALUES (_conversation_id, _client_id, clock_timestamp())
  ON CONFLICT (conversation_id, client_id) DO UPDATE
  SET last_sent_at = EXCLUDED.last_sent_at
  WHERE private.conversation_gift_rate_limits.last_sent_at <= clock_timestamp() - INTERVAL '2 seconds'
  RETURNING last_sent_at INTO _accepted_at;

  IF _accepted_at IS NULL THEN
    RAISE EXCEPTION 'gift_rate_limited';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_message_gift_marker()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _message public.messages%ROWTYPE;
BEGIN
  SELECT * INTO _message
  FROM public.messages message
  WHERE message.id = NEW.message_id;

  IF NOT FOUND
    OR _message.content <> '[gift]'
    OR _message.sender_type <> 'client'::public.sender_type THEN
    RAISE EXCEPTION 'invalid_gift_message_marker';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER message_gifts_marker_guard
  BEFORE INSERT OR UPDATE OF message_id ON public.message_gifts
  FOR EACH ROW
  EXECUTE FUNCTION private.assert_message_gift_marker();

CREATE OR REPLACE FUNCTION public.get_conversation_gifts(
  _conversation_id UUID
)
RETURNS TABLE (
  gift_id UUID,
  collection_id UUID,
  name TEXT,
  collection_name TEXT,
  scope TEXT,
  price_credits INTEGER,
  sort_order INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _guard RECORD;
BEGIN
  IF private.setting_bool('gifts_enabled', false) IS NOT TRUE THEN
    RAISE EXCEPTION 'gifts_disabled';
  END IF;

  SELECT * INTO _guard
  FROM private.assert_client_can_send_gift_message(_conversation_id);

  RETURN QUERY
  SELECT
    gift.id,
    collection.id,
    gift.name,
    collection.name,
    CASE WHEN collection.character_id IS NULL THEN 'global' ELSE 'character' END,
    gift.price_credits,
    gift.sort_order
  FROM public.gifts gift
  JOIN public.gift_collections collection ON collection.id = gift.collection_id
  WHERE gift.is_active = true
    AND collection.is_active = true
    AND (collection.character_id IS NULL OR collection.character_id = _guard.character_id)
  ORDER BY collection.sort_order, collection.name, gift.sort_order, gift.name, gift.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.send_client_gift(
  _conversation_id UUID,
  _gift_id UUID,
  _idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _guard RECORD;
  _attempt private.gift_send_attempts%ROWTYPE;
  _gift RECORD;
  _message public.messages%ROWTYPE;
  _message_gift public.message_gifts%ROWTYPE;
  _wallet_balance INTEGER;
  _balance_after INTEGER;
  _transaction public.credit_transactions%ROWTYPE;
  _fingerprint TEXT := format('gift:%s:%s', _conversation_id, _gift_id);
BEGIN
  IF _idempotency_key IS NULL THEN
    RAISE EXCEPTION 'gift_idempotency_key_required';
  END IF;

  SELECT * INTO _guard
  FROM private.assert_client_can_send_gift_message(_conversation_id);

  SELECT * INTO _attempt
  FROM private.gift_send_attempts attempt
  WHERE attempt.client_id = _guard.user_id
    AND attempt.idempotency_key = _idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF _attempt.request_fingerprint <> _fingerprint THEN
      RAISE EXCEPTION 'gift_idempotency_key_reused';
    END IF;

    IF _attempt.status <> 'succeeded'
      OR _attempt.message_id IS NULL
      OR _attempt.charged_transaction_id IS NULL THEN
      RAISE EXCEPTION 'gift_send_in_progress';
    END IF;

    SELECT * INTO _message FROM public.messages message WHERE message.id = _attempt.message_id;
    SELECT * INTO _message_gift FROM public.message_gifts message_gift WHERE message_gift.message_id = _attempt.message_id;
    SELECT * INTO _transaction FROM public.credit_transactions transaction WHERE transaction.id = _attempt.charged_transaction_id;

    IF NOT FOUND OR _message_gift.id IS NULL OR _transaction.id IS NULL THEN
      RAISE EXCEPTION 'gift_attempt_invariant_failed';
    END IF;

    RETURN jsonb_build_object(
      'message', to_jsonb(_message),
      'message_gift', jsonb_build_object(
        'id', _message_gift.id,
        'message_id', _message_gift.message_id,
        'gift_id', _message_gift.gift_id,
        'gift_name_snapshot', _message_gift.gift_name_snapshot,
        'collection_name_snapshot', _message_gift.collection_name_snapshot,
        'price_credits_snapshot', _message_gift.price_credits_snapshot,
        'created_at', _message_gift.created_at
      ),
      'balance', _transaction.balance_after,
      'already_sent', true
    );
  END IF;

  IF private.setting_bool('gifts_enabled', false) IS NOT TRUE THEN
    RAISE EXCEPTION 'gifts_disabled';
  END IF;

  SELECT
    gift.id,
    gift.name AS gift_name,
    gift.price_credits,
    collection.name AS collection_name
  INTO _gift
  FROM public.gifts gift
  JOIN public.gift_collections collection ON collection.id = gift.collection_id
  WHERE gift.id = _gift_id
    AND gift.is_active = true
    AND collection.is_active = true
    AND (collection.character_id IS NULL OR collection.character_id = _guard.character_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'gift_not_available';
  END IF;

  INSERT INTO private.gift_send_attempts (
    client_id,
    conversation_id,
    gift_id,
    idempotency_key,
    request_fingerprint
  )
  VALUES (
    _guard.user_id,
    _conversation_id,
    _gift.id,
    _idempotency_key,
    _fingerprint
  )
  ON CONFLICT (client_id, idempotency_key) DO NOTHING
  RETURNING * INTO _attempt;

  IF NOT FOUND THEN
    SELECT * INTO _attempt
    FROM private.gift_send_attempts attempt
    WHERE attempt.client_id = _guard.user_id
      AND attempt.idempotency_key = _idempotency_key
    FOR UPDATE;

    IF _attempt.request_fingerprint <> _fingerprint THEN
      RAISE EXCEPTION 'gift_idempotency_key_reused';
    END IF;

    IF _attempt.status <> 'succeeded'
      OR _attempt.message_id IS NULL
      OR _attempt.charged_transaction_id IS NULL THEN
      RAISE EXCEPTION 'gift_send_in_progress';
    END IF;

    SELECT * INTO _message FROM public.messages message WHERE message.id = _attempt.message_id;
    SELECT * INTO _message_gift FROM public.message_gifts message_gift WHERE message_gift.message_id = _attempt.message_id;
    SELECT * INTO _transaction FROM public.credit_transactions transaction WHERE transaction.id = _attempt.charged_transaction_id;

    IF NOT FOUND OR _message_gift.id IS NULL OR _transaction.id IS NULL THEN
      RAISE EXCEPTION 'gift_attempt_invariant_failed';
    END IF;

    RETURN jsonb_build_object(
      'message', to_jsonb(_message),
      'message_gift', jsonb_build_object(
        'id', _message_gift.id,
        'message_id', _message_gift.message_id,
        'gift_id', _message_gift.gift_id,
        'gift_name_snapshot', _message_gift.gift_name_snapshot,
        'collection_name_snapshot', _message_gift.collection_name_snapshot,
        'price_credits_snapshot', _message_gift.price_credits_snapshot,
        'created_at', _message_gift.created_at
      ),
      'balance', _transaction.balance_after,
      'already_sent', true
    );
  END IF;

  PERFORM private.consume_client_gift_rate_limit(_conversation_id, _guard.user_id);

  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_guard.user_id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT wallet.balance INTO _wallet_balance
  FROM public.credit_wallets wallet
  WHERE wallet.user_id = _guard.user_id
  FOR UPDATE;

  IF _wallet_balance < _gift.price_credits THEN
    RAISE EXCEPTION 'insufficient_credits';
  END IF;

  UPDATE public.credit_wallets
  SET
    balance = balance - _gift.price_credits,
    lifetime_spent = lifetime_spent + _gift.price_credits
  WHERE user_id = _guard.user_id
  RETURNING balance INTO _balance_after;

  INSERT INTO public.messages (
    conversation_id,
    sender_type,
    sender_id,
    content,
    created_at
  )
  VALUES (
    _conversation_id,
    'client'::public.sender_type,
    _guard.user_id,
    '[gift]',
    clock_timestamp()
  )
  RETURNING * INTO _message;

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
    _guard.user_id,
    -_gift.price_credits,
    _balance_after,
    'gift_spend',
    'gift_spend',
    _message.id,
    jsonb_build_object(
      'gift_id', _gift.id,
      'price_credits_snapshot', _gift.price_credits,
      'source', 'send_client_gift'
    )
  )
  RETURNING * INTO _transaction;

  INSERT INTO public.message_gifts (
    message_id,
    gift_id,
    gift_name_snapshot,
    collection_name_snapshot,
    price_credits_snapshot,
    charged_transaction_id
  )
  VALUES (
    _message.id,
    _gift.id,
    _gift.gift_name,
    _gift.collection_name,
    _gift.price_credits,
    _transaction.id
  )
  RETURNING * INTO _message_gift;

  UPDATE private.gift_send_attempts
  SET
    status = 'succeeded',
    message_id = _message.id,
    charged_transaction_id = _transaction.id,
    updated_at = clock_timestamp()
  WHERE id = _attempt.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _guard.user_id,
    'gift.sent',
    'message_gift',
    _message_gift.id::TEXT,
    jsonb_build_object(
      'conversation_id', _conversation_id,
      'gift_id', _gift.id,
      'transaction_id', _transaction.id,
      'price_credits_snapshot', _gift.price_credits
    )
  );

  RETURN jsonb_build_object(
    'message', to_jsonb(_message),
    'message_gift', jsonb_build_object(
      'id', _message_gift.id,
      'message_id', _message_gift.message_id,
      'gift_id', _message_gift.gift_id,
      'gift_name_snapshot', _message_gift.gift_name_snapshot,
      'collection_name_snapshot', _message_gift.collection_name_snapshot,
      'price_credits_snapshot', _message_gift.price_credits_snapshot,
      'created_at', _message_gift.created_at
    ),
    'balance', _balance_after,
    'already_sent', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.refund_client_gift(
  _message_gift_id UUID,
  _reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _admin_id UUID := auth.uid();
  _message_gift public.message_gifts%ROWTYPE;
  _message public.messages%ROWTYPE;
  _charge public.credit_transactions%ROWTYPE;
  _refund public.credit_transactions%ROWTYPE;
  _balance_after INTEGER;
BEGIN
  IF _admin_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_only';
  END IF;

  IF _reason IS NULL OR char_length(btrim(_reason)) < 3 THEN
    RAISE EXCEPTION 'refund_reason_required';
  END IF;

  SELECT * INTO _message_gift
  FROM public.message_gifts message_gift
  WHERE message_gift.id = _message_gift_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'gift_message_not_found';
  END IF;

  SELECT * INTO _message
  FROM public.messages message
  WHERE message.id = _message_gift.message_id;

  SELECT * INTO _charge
  FROM public.credit_transactions transaction
  WHERE transaction.id = _message_gift.charged_transaction_id
    AND transaction.type = 'gift_spend';

  IF NOT FOUND OR _message.sender_type <> 'client'::public.sender_type THEN
    RAISE EXCEPTION 'gift_charge_invariant_failed';
  END IF;

  IF _message_gift.refund_transaction_id IS NOT NULL THEN
    SELECT * INTO _refund
    FROM public.credit_transactions transaction
    WHERE transaction.id = _message_gift.refund_transaction_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'gift_refund_invariant_failed';
    END IF;

    RETURN jsonb_build_object(
      'message_gift_id', _message_gift.id,
      'refund_transaction_id', _refund.id,
      'balance', _refund.balance_after,
      'already_refunded', true
    );
  END IF;

  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_message.sender_id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT wallet.balance INTO _balance_after
  FROM public.credit_wallets wallet
  WHERE wallet.user_id = _message.sender_id
  FOR UPDATE;

  UPDATE public.credit_wallets
  SET
    balance = balance + _message_gift.price_credits_snapshot,
    lifetime_earned = lifetime_earned + _message_gift.price_credits_snapshot
  WHERE user_id = _message.sender_id
  RETURNING balance INTO _balance_after;

  INSERT INTO public.credit_transactions (
    user_id,
    amount,
    balance_after,
    type,
    reason,
    message_id,
    created_by,
    metadata
  )
  VALUES (
    _message.sender_id,
    _message_gift.price_credits_snapshot,
    _balance_after,
    'gift_refund',
    btrim(_reason),
    _message.id,
    _admin_id,
    jsonb_build_object(
      'message_gift_id', _message_gift.id,
      'charged_transaction_id', _message_gift.charged_transaction_id,
      'source', 'refund_client_gift'
    )
  )
  RETURNING * INTO _refund;

  UPDATE public.message_gifts
  SET
    refund_transaction_id = _refund.id,
    refunded_at = clock_timestamp(),
    refund_reason = btrim(_reason)
  WHERE id = _message_gift.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'gift.refunded',
    'message_gift',
    _message_gift.id::TEXT,
    jsonb_build_object(
      'transaction_id', _refund.id,
      'charged_transaction_id', _message_gift.charged_transaction_id,
      'amount', _message_gift.price_credits_snapshot,
      'reason', btrim(_reason)
    )
  );

  RETURN jsonb_build_object(
    'message_gift_id', _message_gift.id,
    'refund_transaction_id', _refund.id,
    'balance', _balance_after,
    'already_refunded', false
  );
END;
$$;

REVOKE ALL ON FUNCTION private.assert_client_can_send_gift_message(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.consume_client_gift_rate_limit(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_message_gift_marker() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_conversation_gifts(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_client_gift(UUID, UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.refund_client_gift(UUID, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_conversation_gifts(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_client_gift(UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refund_client_gift(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- WP07: Gifts are catalog entries backed by the existing sticker media, while
-- purchase and each 60-second attachment opening remain distinct operations.

INSERT INTO public.system_settings (key, value)
VALUES
  ('gifts_enabled', 'true'::JSONB),
  ('free_credits_on_signup', '50'::JSONB)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

ALTER TABLE public.stickers
  ADD COLUMN is_gift BOOLEAN NOT NULL DEFAULT FALSE;

-- Preserve the already managed paid catalog as the initial Gift catalog.
UPDATE public.stickers SET is_gift = TRUE WHERE price_credits > 0;

ALTER TABLE public.stickers
  ADD CONSTRAINT stickers_gift_positive_price_check CHECK (is_gift IS FALSE OR price_credits > 0);

ALTER TABLE public.message_attachments
  ADD COLUMN required_gift_id UUID REFERENCES public.stickers(id) ON DELETE RESTRICT,
  ADD COLUMN required_gift_name_snapshot TEXT,
  ADD COLUMN required_gift_price_credits_snapshot INTEGER,
  ADD CONSTRAINT message_attachments_required_gift_shape_check CHECK (
    (required_gift_id IS NULL
      AND required_gift_name_snapshot IS NULL
      AND required_gift_price_credits_snapshot IS NULL)
    OR
    (view_mode = 'paid_open'
      AND required_gift_id IS NOT NULL
      AND char_length(btrim(required_gift_name_snapshot)) BETWEEN 1 AND 100
      AND required_gift_price_credits_snapshot > 0
      AND price_credits_snapshot = required_gift_price_credits_snapshot)
  );

CREATE FUNCTION private.require_gift_for_new_paid_attachment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF NEW.view_mode = 'paid_open' AND NEW.required_gift_id IS NULL THEN
    RAISE EXCEPTION 'paid_attachment_requires_gift';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER require_gift_for_new_paid_attachment
  BEFORE INSERT OR UPDATE OF view_mode, required_gift_id, required_gift_price_credits_snapshot
  ON public.message_attachments
  FOR EACH ROW EXECUTE FUNCTION private.require_gift_for_new_paid_attachment();

CREATE TABLE public.gift_attachment_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id UUID NOT NULL REFERENCES public.message_attachments(id) ON DELETE RESTRICT,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE RESTRICT,
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  gift_id UUID NOT NULL REFERENCES public.stickers(id) ON DELETE RESTRICT,
  gift_name_snapshot TEXT NOT NULL CHECK (char_length(btrim(gift_name_snapshot)) BETWEEN 1 AND 100),
  price_credits_snapshot INTEGER NOT NULL CHECK (price_credits_snapshot > 0),
  idempotency_key UUID NOT NULL,
  charged_transaction_id UUID UNIQUE REFERENCES public.credit_transactions(id) ON DELETE RESTRICT,
  gift_message_id UUID UNIQUE REFERENCES public.messages(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'purchased', 'opened')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  purchased_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  UNIQUE (client_id, idempotency_key),
  CONSTRAINT gift_attachment_purchases_result_shape_check CHECK (
    (status = 'started' AND charged_transaction_id IS NULL AND gift_message_id IS NULL AND purchased_at IS NULL)
    OR
    (status IN ('purchased', 'opened') AND charged_transaction_id IS NOT NULL
      AND gift_message_id IS NOT NULL AND purchased_at IS NOT NULL)
  )
);

CREATE INDEX gift_attachment_purchases_available_idx
  ON public.gift_attachment_purchases (client_id, attachment_id, created_at DESC)
  WHERE status = 'purchased';

CREATE TABLE private.gift_attachment_open_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL UNIQUE REFERENCES public.gift_attachment_purchases(id) ON DELETE RESTRICT,
  attachment_id UUID NOT NULL REFERENCES public.message_attachments(id) ON DELETE RESTRICT,
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  UNIQUE (client_id, idempotency_key),
  CHECK (expires_at > opened_at),
  CHECK (completed_at IS NULL OR completed_at >= opened_at)
);

CREATE TABLE private.gift_reward_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL UNIQUE REFERENCES public.gift_attachment_purchases(id) ON DELETE RESTRICT,
  reward_pool_points NUMERIC(18, 6) NOT NULL CHECK (reward_pool_points >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'distributed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  processed_at TIMESTAMPTZ,
  failure_code TEXT
);

ALTER TABLE public.gift_attachment_purchases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.gift_attachment_purchases FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, attachment_id, conversation_id, gift_id, gift_name_snapshot,
  price_credits_snapshot, status, created_at, purchased_at, opened_at
) ON public.gift_attachment_purchases TO authenticated;
CREATE POLICY "Clients view own Gift attachment purchases"
  ON public.gift_attachment_purchases FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = client_id);
CREATE POLICY "Admins view Gift attachment purchases"
  ON public.gift_attachment_purchases FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE FUNCTION public.set_sticker_gift_status(_sticker_id UUID, _is_gift BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_required'; END IF;
  UPDATE public.stickers
  SET is_gift = COALESCE(_is_gift, FALSE), updated_at = clock_timestamp(), updated_by_user_id = auth.uid()
  WHERE id = _sticker_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'sticker_not_found'; END IF;
END;
$$;

CREATE FUNCTION public.get_admin_gift_statuses()
RETURNS TABLE (sticker_id UUID, is_gift BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_required'; END IF;
  RETURN QUERY SELECT sticker.id, sticker.is_gift FROM public.stickers sticker ORDER BY sticker.id;
END;
$$;

CREATE FUNCTION public.get_conversation_gifts(_conversation_id UUID)
RETURNS TABLE (gift_id UUID, name TEXT, price_credits INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _conversation public.conversations%ROWTYPE;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT private.setting_bool('gifts_enabled', TRUE) THEN RAISE EXCEPTION 'gifts_disabled'; END IF;
  SELECT * INTO _conversation FROM public.conversations conversation WHERE conversation.id = _conversation_id;
  IF NOT FOUND OR _conversation.status = 'closed'::public.conversation_status THEN
    RAISE EXCEPTION 'conversation_not_available';
  END IF;
  IF _conversation.client_id <> _user_id
    AND NOT EXISTS (
      SELECT 1 FROM public.operators operator
      JOIN public.character_operator_assignments assignment ON assignment.operator_id = operator.id
      WHERE operator.user_id = _user_id AND operator.is_active = TRUE
        AND assignment.character_id = _conversation.character_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles role WHERE role.user_id = _user_id AND role.role = 'admin'
    ) THEN RAISE EXCEPTION 'conversation_access_denied'; END IF;

  RETURN QUERY
  SELECT sticker.id, sticker.name, sticker.price_credits
  FROM public.stickers sticker
  JOIN public.sticker_collections collection ON collection.id = sticker.collection_id
  WHERE sticker.is_gift = TRUE AND sticker.is_active = TRUE
    AND sticker.ingest_status = 'ready' AND sticker.price_credits > 0
    AND collection.is_active = TRUE
    AND (collection.character_id IS NULL OR collection.character_id = _conversation.character_id)
  ORDER BY collection.sort_order, sticker.sort_order, sticker.name, sticker.id;
END;
$$;

CREATE FUNCTION private.send_operator_gift_media_message(
  _reservation_id UUID,
  _gift_id UUID,
  _caption TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _reservation public.character_media_reservations%ROWTYPE;
  _gift RECORD;
  _existing public.message_attachments%ROWTYPE;
  _result JSONB;
  _attachment public.message_attachments%ROWTYPE;
  _message JSONB;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  SELECT * INTO _reservation FROM public.character_media_reservations reservation
  WHERE reservation.id = _reservation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_not_found'; END IF;

  IF _reservation.state = 'consumed' THEN
    SELECT * INTO _existing FROM public.message_attachments attachment
    WHERE attachment.reservation_id = _reservation.id;
    IF NOT FOUND OR _existing.view_mode <> 'paid_open'
      OR _existing.required_gift_id IS DISTINCT FROM _gift_id THEN
      RAISE EXCEPTION 'media_reservation_gift_conflict';
    END IF;
    SELECT to_jsonb(message) INTO _message FROM public.messages message WHERE message.id = _existing.message_id;
    RETURN jsonb_build_object(
      'message', _message,
      'attachment', jsonb_build_object(
        'id', _existing.id, 'message_id', _existing.message_id, 'kind', _existing.kind,
        'position', _existing.position, 'caption', _existing.caption,
        'metadata', _existing.metadata, 'view_mode', _existing.view_mode,
        'required_gift_id', _existing.required_gift_id,
        'required_gift_name_snapshot', _existing.required_gift_name_snapshot,
        'required_gift_price_credits_snapshot', _existing.required_gift_price_credits_snapshot,
        'created_at', _existing.created_at
      ),
      'already_sent', TRUE
    );
  END IF;

  SELECT sticker.id, sticker.name, sticker.price_credits INTO _gift
  FROM public.stickers sticker
  JOIN public.sticker_collections collection ON collection.id = sticker.collection_id
  JOIN public.conversations conversation ON conversation.id = _reservation.conversation_id
  WHERE sticker.id = _gift_id AND sticker.is_gift = TRUE AND sticker.is_active = TRUE
    AND sticker.ingest_status = 'ready' AND sticker.price_credits > 0
    AND collection.is_active = TRUE
    AND (collection.character_id IS NULL OR collection.character_id = conversation.character_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'gift_not_available'; END IF;

  _result := private.send_operator_media_message(_reservation_id, _caption, 'permanent');
  SELECT * INTO _attachment FROM public.message_attachments attachment
  WHERE attachment.id = ((_result -> 'attachment') ->> 'id')::UUID FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'message_attachment_not_available'; END IF;

  UPDATE public.message_attachments
  SET view_mode = 'paid_open',
      price_credits_snapshot = _gift.price_credits,
      required_gift_id = _gift.id,
      required_gift_name_snapshot = _gift.name,
      required_gift_price_credits_snapshot = _gift.price_credits,
      metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object('access_contract', 'gift_v1')
  WHERE id = _attachment.id
  RETURNING * INTO _attachment;

  RETURN _result || jsonb_build_object(
    'attachment', jsonb_build_object(
      'id', _attachment.id, 'message_id', _attachment.message_id, 'kind', _attachment.kind,
      'position', _attachment.position, 'caption', _attachment.caption,
      'metadata', _attachment.metadata, 'view_mode', _attachment.view_mode,
      'required_gift_id', _attachment.required_gift_id,
      'required_gift_name_snapshot', _attachment.required_gift_name_snapshot,
      'required_gift_price_credits_snapshot', _attachment.required_gift_price_credits_snapshot,
      'created_at', _attachment.created_at
    )
  );
END;
$$;

CREATE FUNCTION public.send_operator_gift_media_message(
  _reservation_id UUID,
  _gift_id UUID,
  _caption TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp AS $$
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  RAISE EXCEPTION 'handling_cycle_token_required';
END;
$$;

CREATE FUNCTION public.send_operator_gift_media_message(
  _reservation_id UUID,
  _gift_id UUID,
  _caption TEXT,
  _expected_cycle_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation_id UUID;
  _authority RECORD;
  _result JSONB;
  _message_id UUID;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  SELECT reservation.conversation_id INTO _conversation_id
  FROM public.character_media_reservations reservation WHERE reservation.id = _reservation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_not_found'; END IF;
  SELECT * INTO _authority
  FROM private.acquire_operator_send_authority(_conversation_id, _expected_cycle_id);
  _result := private.send_operator_gift_media_message(_reservation_id, _gift_id, _caption);
  _message_id := ((_result -> 'message') ->> 'id')::UUID;
  IF COALESCE((_result ->> 'already_sent')::BOOLEAN, FALSE) THEN
    IF NOT EXISTS (
      SELECT 1 FROM private.handling_send_authority_evidence evidence
      WHERE evidence.message_id = _message_id AND evidence.conversation_id = _conversation_id
        AND evidence.handling_cycle_id = _authority.handling_cycle_id
        AND evidence.operator_id = _authority.operator_id
        AND evidence.actor_user_id = _authority.user_id
    ) THEN RAISE EXCEPTION 'handling_send_authority_evidence_missing'; END IF;
  ELSE
    PERFORM private.record_operator_send_authority_evidence(
      _message_id, _conversation_id, _authority.operator_id, _authority.user_id,
      _authority.handling_cycle_id, _authority.authority_source
    );
  END IF;
  RETURN _result || jsonb_build_object(
    'cycle_id', _authority.handling_cycle_id,
    'authority_source', _authority.authority_source,
    'claimed_now', _authority.claimed_now
  );
END;
$$;

CREATE FUNCTION public.purchase_attachment_gift(
  _attachment_id UUID,
  _gift_id UUID,
  _idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client_id UUID := auth.uid();
  _attachment public.message_attachments%ROWTYPE;
  _conversation public.conversations%ROWTYPE;
  _purchase public.gift_attachment_purchases%ROWTYPE;
  _balance INTEGER;
  _transaction public.credit_transactions%ROWTYPE;
  _gift_message public.messages%ROWTYPE;
  _collection_name TEXT;
BEGIN
  IF _client_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  PERFORM private.ensure_active_client(_client_id);
  IF _idempotency_key IS NULL THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;

  SELECT * INTO _purchase FROM public.gift_attachment_purchases purchase
  WHERE purchase.client_id = _client_id AND purchase.idempotency_key = _idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF _purchase.attachment_id IS DISTINCT FROM _attachment_id OR _purchase.gift_id IS DISTINCT FROM _gift_id THEN
      RAISE EXCEPTION 'idempotency_key_reused';
    END IF;
    RETURN jsonb_build_object(
      'purchase_id', _purchase.id, 'attachment_id', _purchase.attachment_id,
      'gift_id', _purchase.gift_id, 'balance', (SELECT balance FROM public.credit_wallets WHERE user_id = _client_id),
      'already_purchased', _purchase.status IN ('purchased', 'opened')
    );
  END IF;

  SELECT attachment.* INTO _attachment FROM public.message_attachments attachment
  WHERE attachment.id = _attachment_id FOR UPDATE;
  IF NOT FOUND OR _attachment.view_mode <> 'paid_open' OR _attachment.required_gift_id IS NULL THEN
    RAISE EXCEPTION 'gift_attachment_not_available';
  END IF;
  SELECT conversation.* INTO _conversation
  FROM public.messages message JOIN public.conversations conversation ON conversation.id = message.conversation_id
  WHERE message.id = _attachment.message_id FOR UPDATE OF conversation;
  IF NOT FOUND OR _conversation.client_id IS DISTINCT FROM _client_id
    OR _conversation.status = 'closed'::public.conversation_status
    OR _conversation.client_hidden_at IS NOT NULL THEN RAISE EXCEPTION 'conversation_access_denied'; END IF;
  IF _attachment.required_gift_id IS DISTINCT FROM _gift_id THEN RAISE EXCEPTION 'gift_does_not_unlock_attachment'; END IF;

  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_client_id, 0, 0, 0) ON CONFLICT (user_id) DO NOTHING;
  SELECT balance INTO _balance FROM public.credit_wallets WHERE user_id = _client_id FOR UPDATE;
  IF COALESCE(_balance, 0) < _attachment.required_gift_price_credits_snapshot THEN
    RAISE EXCEPTION 'insufficient_credits';
  END IF;

  INSERT INTO public.gift_attachment_purchases (
    attachment_id, conversation_id, client_id, gift_id, gift_name_snapshot,
    price_credits_snapshot, idempotency_key
  ) VALUES (
    _attachment.id, _conversation.id, _client_id, _gift_id,
    _attachment.required_gift_name_snapshot, _attachment.required_gift_price_credits_snapshot,
    _idempotency_key
  ) RETURNING * INTO _purchase;

  UPDATE public.credit_wallets
  SET balance = balance - _purchase.price_credits_snapshot,
      lifetime_spent = lifetime_spent + _purchase.price_credits_snapshot
  WHERE user_id = _client_id RETURNING balance INTO _balance;

  INSERT INTO public.messages (conversation_id, sender_type, sender_id, content, created_at)
  VALUES (_conversation.id, 'client'::public.sender_type, _client_id, '[sticker]', clock_timestamp())
  RETURNING * INTO _gift_message;

  SELECT collection.name INTO _collection_name
  FROM public.stickers sticker JOIN public.sticker_collections collection ON collection.id = sticker.collection_id
  WHERE sticker.id = _gift_id;
  INSERT INTO public.message_stickers (
    message_id, sticker_id, sticker_name_snapshot, collection_name_snapshot, price_credits_snapshot
  ) VALUES (
    _gift_message.id, _gift_id, _purchase.gift_name_snapshot,
    COALESCE(_collection_name, 'Gift'), _purchase.price_credits_snapshot
  );

  INSERT INTO public.credit_transactions (
    user_id, amount, balance_after, type, reason, message_id, message_attachment_id, metadata
  ) VALUES (
    _client_id, -_purchase.price_credits_snapshot, _balance, 'sticker_spend', 'attachment_gift_purchase',
    _gift_message.id, _attachment.id,
    jsonb_build_object('purchase_id', _purchase.id, 'gift_id', _gift_id, 'attachment_id', _attachment.id)
  ) RETURNING * INTO _transaction;

  UPDATE public.message_stickers
  SET payer_client_id = _client_id,
      charged_transaction_id = _transaction.id
  WHERE message_id = _gift_message.id;

  UPDATE public.gift_attachment_purchases
  SET charged_transaction_id = _transaction.id, gift_message_id = _gift_message.id,
      status = 'purchased', purchased_at = clock_timestamp()
  WHERE id = _purchase.id RETURNING * INTO _purchase;

  INSERT INTO private.gift_reward_events (purchase_id, reward_pool_points)
  VALUES (_purchase.id, _purchase.price_credits_snapshot::NUMERIC * 0.10);

  RETURN jsonb_build_object(
    'purchase_id', _purchase.id, 'attachment_id', _purchase.attachment_id,
    'gift_id', _purchase.gift_id, 'balance', _balance,
    'message', to_jsonb(_gift_message), 'already_purchased', FALSE
  );
END;
$$;

CREATE FUNCTION public.open_attachment_gift_purchase(
  _attachment_id UUID,
  _purchase_id UUID,
  _idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client_id UUID := auth.uid();
  _purchase public.gift_attachment_purchases%ROWTYPE;
  _session private.gift_attachment_open_sessions%ROWTYPE;
BEGIN
  IF _client_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF _idempotency_key IS NULL THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;

  SELECT * INTO _session FROM private.gift_attachment_open_sessions session
  WHERE session.client_id = _client_id AND session.idempotency_key = _idempotency_key;
  IF FOUND THEN
    IF _session.attachment_id IS DISTINCT FROM _attachment_id OR _session.purchase_id IS DISTINCT FROM _purchase_id THEN
      RAISE EXCEPTION 'idempotency_key_reused';
    END IF;
    RETURN jsonb_build_object('session_id', _session.id, 'expires_at', _session.expires_at, 'already_opened', TRUE);
  END IF;

  SELECT * INTO _purchase FROM public.gift_attachment_purchases purchase
  WHERE purchase.id = _purchase_id AND purchase.client_id = _client_id FOR UPDATE;
  IF NOT FOUND OR _purchase.attachment_id IS DISTINCT FROM _attachment_id THEN
    RAISE EXCEPTION 'gift_purchase_not_available';
  END IF;
  IF _purchase.status <> 'purchased' THEN RAISE EXCEPTION 'gift_purchase_already_consumed'; END IF;

  INSERT INTO private.gift_attachment_open_sessions (
    purchase_id, attachment_id, client_id, idempotency_key, expires_at
  ) VALUES (
    _purchase.id, _attachment_id, _client_id, _idempotency_key, clock_timestamp() + interval '60 seconds'
  ) RETURNING * INTO _session;
  UPDATE public.gift_attachment_purchases
  SET status = 'opened', opened_at = _session.opened_at WHERE id = _purchase.id;
  RETURN jsonb_build_object('session_id', _session.id, 'expires_at', _session.expires_at, 'already_opened', FALSE);
END;
$$;

DROP FUNCTION public.get_message_attachment_access(UUID[]);
CREATE FUNCTION public.get_message_attachment_access(_attachment_ids UUID[])
RETURNS TABLE (
  attachment_id UUID, access_mode TEXT, render_state TEXT,
  price_credits_snapshot INTEGER, is_unlocked BOOLEAN, view_mode TEXT,
  session_expires_at TIMESTAMPTZ, required_gift_id UUID,
  required_gift_name TEXT, required_gift_price_credits INTEGER,
  available_purchase_id UUID
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _locked_images_enabled BOOLEAN := private.setting_bool('locked_images_enabled', FALSE);
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF _attachment_ids IS NULL OR cardinality(_attachment_ids) = 0 THEN RETURN; END IF;
  IF cardinality(_attachment_ids) > 100 THEN RAISE EXCEPTION 'too_many_attachment_ids'; END IF;
  RETURN QUERY
  SELECT attachment.id, attachment.access_mode,
    CASE
      WHEN attachment.view_mode = 'client_24h' AND attachment.access_expires_at > clock_timestamp() THEN 'client_24h_available'
      WHEN attachment.view_mode = 'client_24h' THEN 'client_24h_expired'
      WHEN attachment.view_mode = 'paid_open' AND attachment.required_gift_id IS NOT NULL
        AND conversation.client_id = _user_id AND gift_session.id IS NOT NULL THEN 'paid_open_active'
      WHEN attachment.view_mode = 'paid_open' AND attachment.required_gift_id IS NOT NULL
        AND conversation.client_id = _user_id AND gift_purchase.id IS NOT NULL THEN 'gift_purchased'
      WHEN attachment.view_mode = 'paid_open' AND attachment.required_gift_id IS NOT NULL
        AND conversation.client_id = _user_id THEN 'gift_purchase_required'
      WHEN attachment.view_mode = 'paid_open' AND conversation.client_id = _user_id
        AND legacy_session.id IS NOT NULL THEN 'paid_open_active'
      WHEN attachment.view_mode = 'paid_open' AND conversation.client_id = _user_id THEN 'paid_open_available'
      WHEN attachment.view_mode = 'paid_open' THEN 'paid_open_staff'
      WHEN attachment.view_mode = 'view_once' AND conversation.client_id = _user_id AND attachment.view_once_opened_at IS NULL THEN 'view_once_available'
      WHEN attachment.view_mode = 'view_once' AND conversation.client_id = _user_id THEN 'view_once_seen'
      WHEN attachment.view_mode = 'view_once' THEN 'view_once_staff'
      WHEN attachment.access_mode = 'standard' THEN 'standard'
      WHEN NOT _locked_images_enabled THEN 'disabled'
      WHEN conversation.client_id = _user_id AND EXISTS (
        SELECT 1 FROM public.message_attachment_unlocks unlock
        WHERE unlock.attachment_id = attachment.id AND unlock.client_id = _user_id AND unlock.revoked_at IS NULL
      ) THEN 'delivery'
      WHEN conversation.client_id = _user_id THEN 'teaser'
      ELSE 'delivery'
    END,
    CASE WHEN conversation.client_id = _user_id THEN attachment.price_credits_snapshot END,
    CASE WHEN conversation.client_id = _user_id AND attachment.access_mode = 'locked' THEN EXISTS (
      SELECT 1 FROM public.message_attachment_unlocks unlock
      WHERE unlock.attachment_id = attachment.id AND unlock.client_id = _user_id AND unlock.revoked_at IS NULL
    ) ELSE NULL END,
    attachment.view_mode,
    CASE WHEN attachment.view_mode = 'client_24h' THEN attachment.access_expires_at
      WHEN gift_session.id IS NOT NULL THEN gift_session.expires_at
      WHEN legacy_session.id IS NOT NULL THEN legacy_session.expires_at END,
    CASE WHEN conversation.client_id = _user_id THEN attachment.required_gift_id END,
    CASE WHEN conversation.client_id = _user_id THEN attachment.required_gift_name_snapshot END,
    CASE WHEN conversation.client_id = _user_id THEN attachment.required_gift_price_credits_snapshot END,
    CASE WHEN conversation.client_id = _user_id THEN gift_purchase.id END
  FROM public.message_attachments attachment
  JOIN public.messages message ON message.id = attachment.message_id
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
  LEFT JOIN LATERAL (
    SELECT session.id, session.expires_at
    FROM private.gift_attachment_open_sessions session
    WHERE session.attachment_id = attachment.id AND session.client_id = _user_id
      AND session.completed_at IS NULL AND session.expires_at > clock_timestamp()
    ORDER BY session.opened_at DESC, session.id DESC LIMIT 1
  ) gift_session ON TRUE
  LEFT JOIN LATERAL (
    SELECT session.id, session.expires_at
    FROM private.message_attachment_open_sessions session
    WHERE session.attachment_id = attachment.id AND session.client_id = _user_id
      AND session.status = 'opened' AND session.completed_at IS NULL
      AND session.expires_at > clock_timestamp()
    ORDER BY session.opened_at DESC, session.id DESC LIMIT 1
  ) legacy_session ON TRUE
  LEFT JOIN LATERAL (
    SELECT purchase.id FROM public.gift_attachment_purchases purchase
    WHERE purchase.attachment_id = attachment.id AND purchase.client_id = _user_id
      AND purchase.status = 'purchased'
    ORDER BY purchase.created_at DESC, purchase.id DESC LIMIT 1
  ) gift_purchase ON TRUE
  WHERE attachment.id = ANY (_attachment_ids)
    AND (conversation.client_id = _user_id
      OR EXISTS (SELECT 1 FROM public.character_operator_assignments assignment
        JOIN public.operators operator ON operator.id = assignment.operator_id
        WHERE assignment.character_id = conversation.character_id
          AND operator.user_id = _user_id AND operator.is_active = TRUE)
      OR EXISTS (SELECT 1 FROM public.user_roles role WHERE role.user_id = _user_id AND role.role = 'admin'));
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_message_attachment_media_for_server(
  _actor_user_id UUID,
  _attachment_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _attachment public.message_attachments%ROWTYPE;
  _conversation public.conversations%ROWTYPE;
  _upload public.client_media_uploads%ROWTYPE;
  _asset public.character_media_assets%ROWTYPE;
  _session private.gift_attachment_open_sessions%ROWTYPE;
  _path TEXT;
  _ttl INTEGER;
  _is_staff BOOLEAN;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT attachment.* INTO _attachment FROM public.message_attachments attachment WHERE attachment.id = _attachment_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT conversation.* INTO _conversation
  FROM public.messages message JOIN public.conversations conversation ON conversation.id = message.conversation_id
  WHERE message.id = _attachment.message_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  _is_staff := EXISTS (SELECT 1 FROM public.user_roles role WHERE role.user_id = _actor_user_id AND role.role = 'admin')
    OR EXISTS (SELECT 1 FROM public.operators operator
      JOIN public.character_operator_assignments assignment ON assignment.operator_id = operator.id
      WHERE operator.user_id = _actor_user_id AND operator.is_active = TRUE
        AND assignment.character_id = _conversation.character_id);

  IF _attachment.client_upload_id IS NOT NULL THEN
    IF _attachment.access_expires_at <= clock_timestamp()
      OR (_conversation.client_id IS DISTINCT FROM _actor_user_id AND NOT _is_staff) THEN RETURN NULL; END IF;
    SELECT * INTO _upload FROM public.client_media_uploads upload WHERE upload.id = _attachment.client_upload_id;
    IF NOT FOUND OR _upload.status = 'deleted' THEN RETURN NULL; END IF;
    _ttl := LEAST(300, FLOOR(EXTRACT(EPOCH FROM (_attachment.access_expires_at - clock_timestamp())))::INTEGER);
    IF _ttl < 1 THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('bucket', _upload.bucket_id, 'path', COALESCE(_upload.preview_path, _upload.source_path), 'ttl_seconds', _ttl);
  END IF;

  IF _attachment.required_gift_id IS NOT NULL THEN
    SELECT * INTO _asset FROM public.character_media_assets asset WHERE asset.id = _attachment.media_asset_id;
    IF NOT FOUND OR _asset.ingest_status <> 'ready' OR _asset.status = 'disabled' THEN RETURN NULL; END IF;
    IF _is_staff THEN
      RETURN jsonb_build_object('bucket', _asset.bucket_id, 'path', _asset.preview_path, 'ttl_seconds', 60);
    END IF;
    IF _conversation.client_id IS DISTINCT FROM _actor_user_id THEN RETURN NULL; END IF;
    SELECT * INTO _session FROM private.gift_attachment_open_sessions session
    WHERE session.attachment_id = _attachment.id AND session.client_id = _actor_user_id
      AND session.completed_at IS NULL AND session.expires_at > clock_timestamp()
    ORDER BY session.opened_at DESC, session.id DESC LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
    _ttl := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (_session.expires_at - clock_timestamp())))::INTEGER);
    RETURN jsonb_build_object('bucket', _asset.bucket_id, 'path', _asset.preview_path, 'ttl_seconds', _ttl);
  END IF;

  _path := public.resolve_character_media_preview_path_for_server(_actor_user_id, 'message_attachment', _attachment_id);
  _ttl := public.get_message_attachment_view_url_ttl_for_server(_actor_user_id, _attachment_id);
  IF _path IS NULL OR _ttl IS NULL OR _ttl < 1 THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('bucket', 'character-media', 'path', _path, 'ttl_seconds', _ttl);
END;
$$;

REVOKE ALL ON FUNCTION private.require_gift_for_new_paid_attachment() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.send_operator_gift_media_message(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE private.gift_attachment_open_sessions, private.gift_reward_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_sticker_gift_status(UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admin_gift_statuses() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_conversation_gifts(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_operator_gift_media_message(UUID, UUID, TEXT), public.send_operator_gift_media_message(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.purchase_attachment_gift(UUID, UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.open_attachment_gift_purchase(UUID, UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_message_attachment_access(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_sticker_gift_status(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_gift_statuses() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_conversation_gifts(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_operator_gift_media_message(UUID, UUID, TEXT), public.send_operator_gift_media_message(UUID, UUID, TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purchase_attachment_gift(UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_attachment_gift_purchase(UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_message_attachment_access(UUID[]) TO authenticated;

NOTIFY pgrst, 'reload schema';

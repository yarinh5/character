-- Phase V2-25: per-open paid image sessions. Legacy locked-image unlocks stay read-only.

ALTER TABLE public.character_media_assets
  ADD COLUMN paid_open_price_credits INTEGER,
  ADD CONSTRAINT character_media_assets_paid_open_price_check
    CHECK (paid_open_price_credits IS NULL OR paid_open_price_credits > 0);

ALTER TABLE public.message_attachments
  DROP CONSTRAINT message_attachments_view_mode_check,
  DROP CONSTRAINT message_attachments_view_once_state_check,
  DROP CONSTRAINT message_attachments_view_once_standard_only_check,
  DROP CONSTRAINT message_attachments_locked_price_snapshot_check;

ALTER TABLE public.message_attachments
  ADD CONSTRAINT message_attachments_view_mode_check
    CHECK (view_mode IN ('permanent', 'view_once', 'paid_open')),
  ADD CONSTRAINT message_attachments_view_once_state_check
    CHECK (
      (view_mode = 'view_once' AND (view_once_completed_at IS NULL OR view_once_opened_at IS NOT NULL))
      OR (view_mode <> 'view_once' AND view_once_opened_at IS NULL AND view_once_completed_at IS NULL)
    ),
  ADD CONSTRAINT message_attachments_view_mode_standard_only_check
    CHECK (view_mode = 'permanent' OR access_mode = 'standard'),
  ADD CONSTRAINT message_attachments_locked_price_snapshot_check
    CHECK (
      (access_mode = 'locked' AND view_mode = 'permanent' AND price_credits_snapshot > 0)
      OR (access_mode = 'standard' AND view_mode IN ('permanent', 'view_once') AND price_credits_snapshot IS NULL)
      OR (access_mode = 'standard' AND view_mode = 'paid_open' AND price_credits_snapshot > 0)
    );

CREATE INDEX message_attachments_paid_open_access_idx
  ON public.message_attachments (message_id, created_at DESC)
  WHERE view_mode = 'paid_open';

ALTER TABLE public.credit_transactions
  DROP CONSTRAINT IF EXISTS credit_transactions_type_check,
  DROP CONSTRAINT IF EXISTS credit_transactions_locked_attachment_check;

ALTER TABLE public.credit_transactions
  ADD CONSTRAINT credit_transactions_type_check
    CHECK (type = ANY (ARRAY[
      'signup_bonus'::TEXT,
      'message_spend'::TEXT,
      'message_payout'::TEXT,
      'operator_message_payout'::TEXT,
      'admin_adjustment'::TEXT,
      'package_purchase'::TEXT,
      'reset_grant'::TEXT,
      'migration_backfill'::TEXT,
      'locked_image_unlock'::TEXT,
      'locked_image_refund'::TEXT,
      'sticker_spend'::TEXT,
      'sticker_payout'::TEXT,
      'sticker_refund'::TEXT,
      'paid_image_open_spend'::TEXT,
      'paid_image_open_payout'::TEXT
    ])),
  ADD CONSTRAINT credit_transactions_attachment_payment_check
    CHECK (
      type NOT IN ('locked_image_unlock', 'locked_image_refund', 'paid_image_open_spend', 'paid_image_open_payout')
      OR message_attachment_id IS NOT NULL
    );

CREATE TABLE private.message_attachment_open_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id UUID NOT NULL REFERENCES public.message_attachments(id) ON DELETE RESTRICT,
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE RESTRICT,
  price_credits_snapshot INTEGER NOT NULL CHECK (price_credits_snapshot > 0),
  charged_transaction_id UUID NOT NULL UNIQUE REFERENCES public.credit_transactions(id) ON DELETE RESTRICT,
  payout_operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE RESTRICT,
  payout_transaction_id UUID NOT NULL UNIQUE REFERENCES public.credit_transactions(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'opened' CHECK (status IN ('opened', 'completed', 'expired')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT message_attachment_open_sessions_client_key_unique UNIQUE (client_id, idempotency_key),
  CONSTRAINT message_attachment_open_sessions_time_check CHECK (expires_at > opened_at),
  CONSTRAINT message_attachment_open_sessions_completion_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);

CREATE INDEX message_attachment_open_sessions_attachment_client_opened_idx
  ON private.message_attachment_open_sessions (attachment_id, client_id, opened_at DESC);

CREATE TABLE private.message_attachment_open_rate_limits (
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES public.message_attachments(id) ON DELETE CASCADE,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (client_id, attachment_id)
);

ALTER TABLE private.message_attachment_open_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.message_attachment_open_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.message_attachment_open_sessions, private.message_attachment_open_rate_limits FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.resolve_paid_attachment_payout_operator(
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
  SELECT cycle.operator_id, operator.user_id
  INTO operator_id, user_id
  FROM public.conversation_handling_cycles cycle
  JOIN public.operators operator ON operator.id = cycle.operator_id
  WHERE cycle.conversation_id = _conversation_id
    AND cycle.ended_at IS NULL
    AND operator.is_active = TRUE
    AND operator.deleted_at IS NULL
  ORDER BY cycle.started_at DESC, cycle.id DESC
  LIMIT 1;

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

CREATE OR REPLACE FUNCTION private.consume_paid_attachment_open_rate_limit(
  _client_id UUID,
  _attachment_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _row private.message_attachment_open_rate_limits%ROWTYPE;
BEGIN
  INSERT INTO private.message_attachment_open_rate_limits (client_id, attachment_id)
  VALUES (_client_id, _attachment_id)
  ON CONFLICT (client_id, attachment_id) DO NOTHING;

  SELECT * INTO _row
  FROM private.message_attachment_open_rate_limits
  WHERE client_id = _client_id AND attachment_id = _attachment_id
  FOR UPDATE;

  IF _row.window_started_at <= clock_timestamp() - INTERVAL '1 minute' THEN
    UPDATE private.message_attachment_open_rate_limits
    SET window_started_at = clock_timestamp(), attempt_count = 1, updated_at = clock_timestamp()
    WHERE client_id = _client_id AND attachment_id = _attachment_id;
    RETURN;
  END IF;

  IF _row.attempt_count >= 6 THEN
    RAISE EXCEPTION 'paid_image_open_rate_limited';
  END IF;

  UPDATE private.message_attachment_open_rate_limits
  SET attempt_count = attempt_count + 1, updated_at = clock_timestamp()
  WHERE client_id = _client_id AND attachment_id = _attachment_id;
END;
$$;

DROP FUNCTION public.send_operator_media_message(UUID, TEXT, TEXT);

CREATE FUNCTION public.send_operator_media_message(
  _reservation_id UUID,
  _caption TEXT DEFAULT NULL,
  _view_mode TEXT DEFAULT 'permanent'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _caption_clean TEXT := NULLIF(btrim(COALESCE(_caption, '')), '');
  _view_mode_clean TEXT := lower(btrim(COALESCE(_view_mode, 'permanent')));
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
  IF _view_mode_clean NOT IN ('permanent', 'view_once', 'paid_open') THEN
    RAISE EXCEPTION 'invalid_media_view_mode';
  END IF;

  SELECT reservation.conversation_id, reservation.media_asset_id
  INTO _conversation_id, _asset_id
  FROM public.character_media_reservations reservation
  WHERE reservation.id = _reservation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_not_found'; END IF;

  SELECT * INTO _guard
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);
  PERFORM private.expire_character_media_reservations(NULL, _asset_id);

  SELECT * INTO _asset FROM public.character_media_assets asset WHERE asset.id = _asset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_asset_not_found'; END IF;
  SELECT * INTO _reservation FROM public.character_media_reservations reservation WHERE reservation.id = _reservation_id FOR UPDATE;
  IF _reservation.operator_id <> _guard.operator_id THEN RAISE EXCEPTION 'media_reservation_not_owned'; END IF;

  IF _reservation.state = 'consumed' THEN
    SELECT to_jsonb(message) INTO _message
    FROM public.message_attachments attachment JOIN public.messages message ON message.id = attachment.message_id
    WHERE attachment.reservation_id = _reservation.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_consumed_without_attachment'; END IF;

    SELECT jsonb_build_object(
      'message', _message,
      'attachment', jsonb_build_object(
        'id', attachment.id, 'message_id', attachment.message_id, 'kind', attachment.kind, 'position', attachment.position,
        'caption', attachment.caption, 'metadata', attachment.metadata, 'view_mode', attachment.view_mode, 'created_at', attachment.created_at
      ),
      'already_sent', true, 'concurrency_mode', _guard.concurrency_mode
    ) INTO _idempotent_result
    FROM public.message_attachments attachment
    WHERE attachment.reservation_id = _reservation.id AND attachment.view_mode = _view_mode_clean;
    IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_view_mode_conflict'; END IF;
    RETURN _idempotent_result;
  END IF;

  IF _reservation.state = 'released' THEN RAISE EXCEPTION 'media_reservation_released';
  ELSIF _reservation.state = 'expired' THEN RAISE EXCEPTION 'media_reservation_expired';
  ELSIF _reservation.state <> 'active' THEN RAISE EXCEPTION 'media_reservation_not_active';
  END IF;
  IF _asset.status <> 'reserved' THEN RAISE EXCEPTION 'media_asset_not_reserved'; END IF;
  IF _asset.ingest_status <> 'ready' THEN RAISE EXCEPTION 'media_asset_not_ready'; END IF;
  IF _view_mode_clean IN ('view_once', 'paid_open') AND _reservation.intended_access_mode <> 'standard' THEN
    RAISE EXCEPTION 'view_mode_requires_standard_media';
  END IF;
  IF _view_mode_clean = 'paid_open' AND COALESCE(_asset.paid_open_price_credits, 0) <= 0 THEN
    RAISE EXCEPTION 'paid_open_requires_positive_price';
  END IF;

  SELECT * INTO _message_result
  FROM private.create_operator_message_with_scoring(
    _conversation_id, _guard.operator_id, _guard.user_id, COALESCE(_caption_clean, '[image]'),
    jsonb_build_object('source', 'send_operator_media_message', 'attachment_kind', 'image', 'view_mode', _view_mode_clean)
  );

  INSERT INTO public.message_attachments (
    message_id, media_asset_id, reservation_id, kind, position, caption, view_mode, price_credits_snapshot
  ) VALUES (
    _message_result.message_id, _asset.id, _reservation.id, 'image', 0, _caption_clean, _view_mode_clean,
    CASE WHEN _view_mode_clean = 'paid_open' THEN _asset.paid_open_price_credits ELSE NULL END
  ) RETURNING * INTO _attachment;

  UPDATE public.character_media_reservations
  SET state = 'consumed', ended_at = clock_timestamp(), ended_by_user_id = _guard.user_id, ended_reason = 'sent'
  WHERE id = _reservation.id;
  UPDATE public.character_media_assets
  SET status = 'sent', updated_by_user_id = _guard.user_id
  WHERE id = _asset.id AND status = 'reserved';

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES
    (_guard.user_id, 'character_media_reservation.consumed', 'character_media_reservation', _reservation.id::TEXT,
      jsonb_build_object('media_asset_id', _asset.id, 'message_id', _message_result.message_id, 'view_mode', _view_mode_clean)),
    (_guard.user_id, 'message_attachment.created', 'message_attachment', _attachment.id::TEXT,
      jsonb_build_object('message_id', _message_result.message_id, 'kind', 'image', 'view_mode', _view_mode_clean));

  RETURN jsonb_build_object(
    'message', _message_result.message,
    'attachment', jsonb_build_object(
      'id', _attachment.id, 'message_id', _attachment.message_id, 'kind', _attachment.kind, 'position', _attachment.position,
      'caption', _attachment.caption, 'metadata', _attachment.metadata, 'view_mode', _attachment.view_mode, 'created_at', _attachment.created_at
    ),
    'already_sent', false, 'score_awarded', _message_result.score_awarded,
    'streak_position', _message_result.streak_position, 'consecutive_message_limit', _message_result.consecutive_message_limit,
    'monthly_points', _message_result.monthly_points, 'scoring_enabled', _message_result.scoring_enabled,
    'concurrency_mode', _guard.concurrency_mode
  );
END;
$$;

CREATE FUNCTION public.open_paid_message_attachment(
  _attachment_id UUID,
  _idempotency_key TEXT
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
  _existing_session private.message_attachment_open_sessions%ROWTYPE;
  _active_session private.message_attachment_open_sessions%ROWTYPE;
  _payout_operator_id UUID;
  _payout_user_id UUID;
  _client_balance INTEGER;
  _client_balance_after INTEGER;
  _payout_balance_after INTEGER;
  _spend public.credit_transactions%ROWTYPE;
  _payout public.credit_transactions%ROWTYPE;
  _session private.message_attachment_open_sessions%ROWTYPE;
BEGIN
  IF _client_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NULLIF(btrim(COALESCE(_idempotency_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'paid_image_idempotency_key_required';
  END IF;
  PERFORM private.ensure_active_client(_client_id);

  SELECT session.* INTO _existing_session
  FROM private.message_attachment_open_sessions session
  WHERE session.client_id = _client_id AND session.idempotency_key = _idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF _existing_session.attachment_id <> _attachment_id THEN RAISE EXCEPTION 'paid_image_idempotency_key_reused'; END IF;
    RETURN jsonb_build_object(
      'session_id', _existing_session.id,
      'expires_at', _existing_session.expires_at,
      'already_opened', true
    );
  END IF;

  SELECT attachment.* INTO _attachment
  FROM public.message_attachments attachment
  WHERE attachment.id = _attachment_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'message_attachment_not_available'; END IF;

  SELECT conversation.* INTO _conversation
  FROM public.messages message
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
  WHERE message.id = _attachment.message_id
  FOR UPDATE OF conversation;
  IF NOT FOUND OR _conversation.client_id <> _client_id THEN RAISE EXCEPTION 'message_attachment_not_available'; END IF;
  IF _conversation.status = 'closed'::public.conversation_status THEN RAISE EXCEPTION 'conversation_closed'; END IF;
  IF _attachment.view_mode <> 'paid_open' OR _attachment.access_mode <> 'standard'
    OR COALESCE(_attachment.price_credits_snapshot, 0) <= 0 THEN
    RAISE EXCEPTION 'paid_image_not_available';
  END IF;

  UPDATE private.message_attachment_open_sessions
  SET status = 'expired', updated_at = clock_timestamp()
  WHERE attachment_id = _attachment.id
    AND client_id = _client_id
    AND status = 'opened'
    AND completed_at IS NULL
    AND expires_at <= clock_timestamp();

  SELECT session.* INTO _active_session
  FROM private.message_attachment_open_sessions session
  WHERE session.attachment_id = _attachment.id
    AND session.client_id = _client_id
    AND session.status = 'opened'
    AND session.completed_at IS NULL
    AND session.expires_at > clock_timestamp()
  ORDER BY session.opened_at DESC, session.id DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('session_id', _active_session.id, 'expires_at', _active_session.expires_at, 'already_opened', true);
  END IF;

  PERFORM private.consume_paid_attachment_open_rate_limit(_client_id, _attachment.id);

  SELECT resolved.operator_id, resolved.user_id
  INTO _payout_operator_id, _payout_user_id
  FROM private.resolve_paid_attachment_payout_operator(_conversation.id) resolved;
  IF _payout_operator_id IS NULL OR _payout_user_id IS NULL OR _payout_user_id = _client_id THEN
    RAISE EXCEPTION 'paid_image_requires_operator_context';
  END IF;

  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_client_id, 0, 0, 0), (_payout_user_id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  IF _client_id < _payout_user_id THEN
    SELECT wallet.balance INTO _client_balance FROM public.credit_wallets wallet WHERE wallet.user_id = _client_id FOR UPDATE;
    PERFORM 1 FROM public.credit_wallets wallet WHERE wallet.user_id = _payout_user_id FOR UPDATE;
  ELSE
    PERFORM 1 FROM public.credit_wallets wallet WHERE wallet.user_id = _payout_user_id FOR UPDATE;
    SELECT wallet.balance INTO _client_balance FROM public.credit_wallets wallet WHERE wallet.user_id = _client_id FOR UPDATE;
  END IF;
  IF COALESCE(_client_balance, 0) < _attachment.price_credits_snapshot THEN
    RAISE EXCEPTION 'insufficient_credits';
  END IF;

  UPDATE public.credit_wallets
  SET balance = balance - _attachment.price_credits_snapshot,
      lifetime_spent = lifetime_spent + _attachment.price_credits_snapshot
  WHERE user_id = _client_id
  RETURNING balance INTO _client_balance_after;
  UPDATE public.credit_wallets
  SET balance = balance + _attachment.price_credits_snapshot,
      lifetime_earned = lifetime_earned + _attachment.price_credits_snapshot
  WHERE user_id = _payout_user_id
  RETURNING balance INTO _payout_balance_after;

  INSERT INTO public.credit_transactions (user_id, amount, balance_after, type, reason, message_id, message_attachment_id, metadata)
  VALUES (
    _client_id, -_attachment.price_credits_snapshot, _client_balance_after, 'paid_image_open_spend', 'paid_image_open',
    _attachment.message_id, _attachment.id,
    jsonb_build_object('price_credits_snapshot', _attachment.price_credits_snapshot, 'payout_operator_id', _payout_operator_id, 'source', 'open_paid_message_attachment')
  ) RETURNING * INTO _spend;
  INSERT INTO public.credit_transactions (user_id, amount, balance_after, type, reason, message_id, message_attachment_id, metadata)
  VALUES (
    _payout_user_id, _attachment.price_credits_snapshot, _payout_balance_after, 'paid_image_open_payout', 'paid_image_open_payout',
    _attachment.message_id, _attachment.id,
    jsonb_build_object('price_credits_snapshot', _attachment.price_credits_snapshot, 'payer_client_id', _client_id, 'payout_operator_id', _payout_operator_id, 'source', 'open_paid_message_attachment')
  ) RETURNING * INTO _payout;

  INSERT INTO private.message_attachment_open_sessions (
    attachment_id, client_id, conversation_id, price_credits_snapshot, charged_transaction_id,
    payout_operator_id, payout_transaction_id, idempotency_key, status, opened_at, expires_at, metadata
  ) VALUES (
    _attachment.id, _client_id, _conversation.id, _attachment.price_credits_snapshot, _spend.id,
    _payout_operator_id, _payout.id, _idempotency_key, 'opened', clock_timestamp(), clock_timestamp() + INTERVAL '7 seconds',
    jsonb_build_object('source', 'open_paid_message_attachment')
  ) RETURNING * INTO _session;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_client_id, 'message_attachment.paid_opened', 'message_attachment_open_session', _session.id::TEXT,
    jsonb_build_object('attachment_id', _attachment.id, 'conversation_id', _conversation.id, 'payout_operator_id', _payout_operator_id));

  RETURN jsonb_build_object('session_id', _session.id, 'expires_at', _session.expires_at, 'balance', _client_balance_after, 'already_opened', false);
END;
$$;

CREATE FUNCTION public.complete_paid_message_attachment_session(
  _session_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client_id UUID := auth.uid();
  _session private.message_attachment_open_sessions%ROWTYPE;
BEGIN
  IF _client_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT * INTO _session
  FROM private.message_attachment_open_sessions session
  WHERE session.id = _session_id AND session.client_id = _client_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'message_attachment_session_not_available'; END IF;

  IF _session.status = 'completed' THEN
    RETURN jsonb_build_object('session_id', _session.id, 'completed', true);
  END IF;
  UPDATE private.message_attachment_open_sessions
  SET status = CASE WHEN expires_at <= clock_timestamp() THEN 'expired' ELSE 'completed' END,
      completed_at = CASE WHEN expires_at <= clock_timestamp() THEN NULL ELSE clock_timestamp() END,
      updated_at = clock_timestamp()
  WHERE id = _session.id
  RETURNING * INTO _session;
  RETURN jsonb_build_object('session_id', _session.id, 'completed', _session.status = 'completed');
END;
$$;

DROP FUNCTION public.get_message_attachment_access(UUID[]);

CREATE FUNCTION public.get_message_attachment_access(_attachment_ids UUID[])
RETURNS TABLE (
  attachment_id UUID,
  access_mode TEXT,
  render_state TEXT,
  price_credits_snapshot INTEGER,
  is_unlocked BOOLEAN,
  view_mode TEXT,
  session_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _locked_images_enabled BOOLEAN := private.setting_bool('locked_images_enabled', false);
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF _attachment_ids IS NULL OR cardinality(_attachment_ids) = 0 THEN RETURN; END IF;
  IF cardinality(_attachment_ids) > 100 THEN RAISE EXCEPTION 'too_many_attachment_ids'; END IF;

  RETURN QUERY
  SELECT
    attachment.id,
    attachment.access_mode,
    CASE
      WHEN attachment.view_mode = 'paid_open' AND conversation.client_id = _user_id AND paid_session.id IS NOT NULL THEN 'paid_open_active'
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
    CASE WHEN conversation.client_id = _user_id AND attachment.access_mode = 'locked' THEN attachment.price_credits_snapshot
         WHEN conversation.client_id = _user_id AND attachment.view_mode = 'paid_open' THEN attachment.price_credits_snapshot
         ELSE NULL END,
    CASE WHEN conversation.client_id = _user_id AND attachment.access_mode = 'locked' THEN EXISTS (
      SELECT 1 FROM public.message_attachment_unlocks unlock
      WHERE unlock.attachment_id = attachment.id AND unlock.client_id = _user_id AND unlock.revoked_at IS NULL
    ) ELSE NULL END,
    attachment.view_mode,
    CASE WHEN conversation.client_id = _user_id AND attachment.view_mode = 'paid_open' THEN paid_session.expires_at ELSE NULL END
  FROM public.message_attachments attachment
  JOIN public.messages message ON message.id = attachment.message_id
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
  LEFT JOIN LATERAL (
    SELECT session.id, session.expires_at
    FROM private.message_attachment_open_sessions session
    WHERE session.attachment_id = attachment.id
      AND session.client_id = _user_id
      AND session.status = 'opened'
      AND session.completed_at IS NULL
      AND session.expires_at > clock_timestamp()
    ORDER BY session.opened_at DESC, session.id DESC
    LIMIT 1
  ) paid_session ON TRUE
  WHERE attachment.id = ANY (_attachment_ids)
    AND (
      conversation.client_id = _user_id
      OR EXISTS (
        SELECT 1
        FROM public.character_operator_assignments assignment
        JOIN public.operators operator ON operator.id = assignment.operator_id
        WHERE assignment.character_id = conversation.character_id AND operator.user_id = _user_id AND operator.is_active = TRUE
      )
      OR EXISTS (SELECT 1 FROM public.user_roles role WHERE role.user_id = _user_id AND role.role = 'admin')
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_message_attachment_view_url_ttl_for_server(
  _actor_user_id UUID,
  _attachment_id UUID
)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT CASE
    WHEN conversation.client_id = _actor_user_id AND attachment.view_mode = 'paid_open'
      AND EXISTS (
        SELECT 1 FROM private.message_attachment_open_sessions session
        WHERE session.attachment_id = attachment.id AND session.client_id = _actor_user_id
          AND session.status = 'opened' AND session.completed_at IS NULL AND session.expires_at > clock_timestamp()
      )
      THEN GREATEST(1, CEIL(EXTRACT(EPOCH FROM ((
        SELECT session.expires_at FROM private.message_attachment_open_sessions session
        WHERE session.attachment_id = attachment.id AND session.client_id = _actor_user_id
          AND session.status = 'opened' AND session.completed_at IS NULL AND session.expires_at > clock_timestamp()
        ORDER BY session.opened_at DESC, session.id DESC LIMIT 1
      ) - clock_timestamp())))::INTEGER)
    WHEN conversation.client_id = _actor_user_id AND attachment.view_mode = 'paid_open' THEN NULL
    WHEN conversation.client_id = _actor_user_id AND attachment.view_mode = 'view_once'
      AND attachment.view_once_opened_at IS NOT NULL AND attachment.view_once_completed_at IS NULL
      AND attachment.view_once_opened_at + interval '7 seconds' > clock_timestamp()
      THEN GREATEST(1, CEIL(EXTRACT(EPOCH FROM (attachment.view_once_opened_at + interval '7 seconds' - clock_timestamp())))::INTEGER)
    WHEN conversation.client_id = _actor_user_id AND attachment.view_mode = 'view_once' THEN NULL
    ELSE 60
  END
  FROM public.message_attachments attachment
  JOIN public.messages message ON message.id = attachment.message_id
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
  WHERE attachment.id = _attachment_id;
$$;

CREATE OR REPLACE FUNCTION public.resolve_character_media_preview_path_for_server(
  _actor_user_id UUID,
  _target_kind TEXT,
  _target_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _path TEXT;
  _concurrency_mode TEXT := COALESCE(private.setting_text('concurrency_mode', 'open'), 'open');
BEGIN
  IF _actor_user_id IS NULL OR _target_id IS NULL THEN RETURN NULL; END IF;
  IF _target_kind IN ('admin_asset_preview', 'admin_locked_teaser_preview', 'admin_locked_delivery_preview') THEN
    SELECT CASE _target_kind WHEN 'admin_asset_preview' THEN asset.preview_path WHEN 'admin_locked_teaser_preview' THEN asset.locked_teaser_path WHEN 'admin_locked_delivery_preview' THEN asset.locked_delivery_path END
    INTO _path FROM public.character_media_assets asset
    WHERE asset.id = _target_id AND asset.bucket_id = 'character-media' AND asset.ingest_status = 'ready'
      AND ((_target_kind = 'admin_asset_preview' AND asset.preview_generated_at IS NOT NULL)
        OR (_target_kind IN ('admin_locked_teaser_preview', 'admin_locked_delivery_preview') AND asset.locked_derivative_status = 'ready'))
      AND EXISTS (SELECT 1 FROM public.user_roles role WHERE role.user_id = _actor_user_id AND role.role = 'admin');
    RETURN _path;
  END IF;
  IF _target_kind = 'message_attachment' THEN
    SELECT CASE
      WHEN attachment.view_mode = 'paid_open' AND conversation.client_id = _actor_user_id AND EXISTS (
        SELECT 1 FROM private.message_attachment_open_sessions session
        WHERE session.attachment_id = attachment.id AND session.client_id = _actor_user_id
          AND session.status = 'opened' AND session.completed_at IS NULL AND session.expires_at > clock_timestamp()
      ) THEN asset.preview_path
      WHEN attachment.view_mode = 'paid_open' AND conversation.client_id = _actor_user_id THEN NULL
      WHEN attachment.view_mode = 'paid_open' THEN asset.preview_path
      WHEN attachment.view_mode = 'view_once' AND conversation.client_id = _actor_user_id
        AND attachment.view_once_opened_at IS NOT NULL AND attachment.view_once_completed_at IS NULL
        AND attachment.view_once_opened_at + interval '7 seconds' > clock_timestamp() THEN asset.preview_path
      WHEN attachment.view_mode = 'view_once' AND conversation.client_id = _actor_user_id THEN NULL
      WHEN attachment.view_mode = 'view_once' THEN asset.preview_path
      WHEN attachment.access_mode = 'standard' THEN asset.preview_path
      WHEN NOT private.setting_bool('locked_images_enabled', false) THEN NULL
      WHEN conversation.client_id = _actor_user_id AND EXISTS (
        SELECT 1 FROM public.message_attachment_unlocks unlock WHERE unlock.attachment_id = attachment.id AND unlock.client_id = _actor_user_id AND unlock.revoked_at IS NULL
      ) THEN asset.locked_delivery_path
      WHEN conversation.client_id = _actor_user_id THEN asset.locked_teaser_path
      ELSE asset.locked_delivery_path
    END INTO _path
    FROM public.message_attachments attachment
    JOIN public.messages message ON message.id = attachment.message_id
    JOIN public.conversations conversation ON conversation.id = message.conversation_id
    JOIN public.character_media_assets asset ON asset.id = attachment.media_asset_id
    WHERE attachment.id = _target_id AND asset.bucket_id = 'character-media' AND asset.ingest_status = 'ready' AND asset.status <> 'disabled'
      AND ((attachment.view_mode IN ('view_once', 'paid_open') AND attachment.access_mode = 'standard' AND asset.preview_generated_at IS NOT NULL)
        OR (attachment.view_mode = 'permanent' AND ((attachment.access_mode = 'standard' AND asset.preview_generated_at IS NOT NULL) OR (attachment.access_mode = 'locked' AND asset.locked_derivative_status = 'ready'))))
      AND (conversation.client_id = _actor_user_id
        OR EXISTS (SELECT 1 FROM public.character_operator_assignments assignment JOIN public.operators operator ON operator.id = assignment.operator_id WHERE assignment.character_id = conversation.character_id AND operator.user_id = _actor_user_id AND operator.is_active = TRUE)
        OR EXISTS (SELECT 1 FROM public.user_roles role WHERE role.user_id = _actor_user_id AND role.role = 'admin'));
    RETURN _path;
  END IF;
  IF _target_kind = 'reserved_preview' THEN
    SELECT CASE reservation.intended_access_mode WHEN 'standard' THEN asset.preview_path WHEN 'locked' THEN asset.locked_teaser_path END INTO _path
    FROM public.character_media_reservations reservation
    JOIN public.character_media_assets asset ON asset.id = reservation.media_asset_id
    JOIN public.conversations conversation ON conversation.id = reservation.conversation_id
    WHERE reservation.id = _target_id AND reservation.state = 'active' AND reservation.expires_at > clock_timestamp() AND conversation.status <> 'closed'
      AND asset.bucket_id = 'character-media' AND asset.ingest_status = 'ready' AND asset.status = 'reserved'
      AND ((reservation.intended_access_mode = 'standard' AND asset.preview_generated_at IS NOT NULL)
        OR (reservation.intended_access_mode = 'locked' AND private.setting_bool('locked_images_enabled', false) AND asset.locked_derivative_status = 'ready'))
      AND (EXISTS (SELECT 1 FROM public.character_operator_assignments assignment JOIN public.operators operator ON operator.id = assignment.operator_id WHERE assignment.character_id = conversation.character_id AND operator.user_id = _actor_user_id AND operator.is_active = TRUE)
        OR EXISTS (SELECT 1 FROM public.user_roles role WHERE role.user_id = _actor_user_id AND role.role = 'admin'));
    RETURN _path;
  END IF;
  RETURN NULL;
END;
$$;

DROP FUNCTION public.get_operator_media_catalog(UUID);
CREATE FUNCTION public.get_operator_media_catalog(_conversation_id UUID)
RETURNS TABLE (
  id UUID, display_name TEXT, status TEXT, ingest_status TEXT, content_type TEXT, byte_size BIGINT, width INTEGER, height INTEGER,
  is_reservable BOOLEAN, is_locked_reservable BOOLEAN, locked_derivative_status TEXT, locked_price_credits INTEGER,
  paid_open_price_credits INTEGER, locked_images_enabled BOOLEAN, is_reserved_by_me BOOLEAN, my_reservation_id UUID,
  my_reservation_expires_at TIMESTAMPTZ, my_reservation_access_mode TEXT, media_tag_id UUID, media_tag_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _guard RECORD;
  _locked_images_enabled BOOLEAN := private.setting_bool('locked_images_enabled', false);
BEGIN
  SELECT * INTO _guard FROM private.assert_operator_can_view_conversation_media(_conversation_id);
  PERFORM private.expire_character_media_reservations(_guard.character_id, NULL);
  RETURN QUERY
  SELECT asset.id, asset.display_name, asset.status, asset.ingest_status, asset.content_type, asset.byte_size, asset.width, asset.height,
    (asset.status IN ('available', 'restored') AND asset.ingest_status = 'ready' AND asset.locked_price_credits IS NULL),
    (_locked_images_enabled AND asset.status IN ('available', 'restored') AND asset.ingest_status = 'ready' AND asset.locked_price_credits IS NOT NULL AND asset.locked_derivative_status = 'ready'),
    asset.locked_derivative_status, asset.locked_price_credits, asset.paid_open_price_credits, _locked_images_enabled,
    COALESCE(reservation.operator_id = _guard.operator_id, FALSE),
    CASE WHEN reservation.operator_id = _guard.operator_id THEN reservation.id END,
    CASE WHEN reservation.operator_id = _guard.operator_id THEN reservation.expires_at END,
    CASE WHEN reservation.operator_id = _guard.operator_id THEN reservation.intended_access_mode END,
    asset.media_tag_id, tag.name
  FROM public.character_media_assets asset
  JOIN public.media_tags tag ON tag.id = asset.media_tag_id
  LEFT JOIN public.character_media_reservations reservation ON reservation.media_asset_id = asset.id AND reservation.state = 'active'
  WHERE asset.character_id = _guard.character_id
  ORDER BY tag.sort_order ASC, tag.name ASC, asset.created_at DESC, asset.id DESC;
END;
$$;

DROP FUNCTION public.get_admin_media_catalog(UUID);
CREATE FUNCTION public.get_admin_media_catalog(_conversation_id UUID)
RETURNS TABLE (
  id UUID, display_name TEXT, status TEXT, ingest_status TEXT, content_type TEXT, byte_size BIGINT, width INTEGER, height INTEGER,
  is_reservable BOOLEAN, is_locked_reservable BOOLEAN, locked_derivative_status TEXT, locked_price_credits INTEGER,
  paid_open_price_credits INTEGER, locked_images_enabled BOOLEAN, is_reserved_by_me BOOLEAN, my_reservation_id UUID,
  my_reservation_expires_at TIMESTAMPTZ, my_reservation_access_mode TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM private.assert_admin_operator_identity_for_conversation(_conversation_id);
  RETURN QUERY
  SELECT catalog.id, catalog.display_name, catalog.status, catalog.ingest_status, catalog.content_type, catalog.byte_size, catalog.width, catalog.height,
    catalog.is_reservable, catalog.is_locked_reservable, catalog.locked_derivative_status, catalog.locked_price_credits,
    catalog.paid_open_price_credits, catalog.locked_images_enabled, catalog.is_reserved_by_me, catalog.my_reservation_id,
    catalog.my_reservation_expires_at, catalog.my_reservation_access_mode
  FROM public.get_operator_media_catalog(_conversation_id) catalog;
END;
$$;

DROP FUNCTION public.get_admin_character_media_assets(UUID);
CREATE FUNCTION public.get_admin_character_media_assets(_character_id UUID)
RETURNS TABLE (
  id UUID, display_name TEXT, content_type TEXT, byte_size BIGINT, width INTEGER, height INTEGER, status TEXT, ingest_status TEXT,
  preview_available BOOLEAN, locked_derivative_status TEXT, locked_derivatives_generated_at TIMESTAMPTZ, locked_derivative_error_code TEXT,
  locked_price_credits INTEGER, paid_open_price_credits INTEGER, locked_preview_available BOOLEAN, created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ, disabled_at TIMESTAMPTZ, disabled_reason TEXT, processing_started_at TIMESTAMPTZ,
  processing_attempts INTEGER, processing_error_code TEXT, media_tag_id UUID, media_tag_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_required'; END IF;
  RETURN QUERY
  SELECT asset.id, asset.display_name, asset.content_type, asset.byte_size, asset.width, asset.height, asset.status, asset.ingest_status,
    (asset.ingest_status = 'ready' AND asset.preview_generated_at IS NOT NULL), asset.locked_derivative_status,
    asset.locked_derivatives_generated_at, asset.locked_derivative_error_code, asset.locked_price_credits,
    asset.paid_open_price_credits, (asset.locked_derivative_status = 'ready'), asset.created_at, asset.updated_at,
    asset.disabled_at, asset.disabled_reason, asset.processing_started_at, asset.processing_attempts, asset.processing_error_code,
    asset.media_tag_id, tag.name
  FROM public.character_media_assets asset
  JOIN public.media_tags tag ON tag.id = asset.media_tag_id
  WHERE asset.character_id = _character_id
  ORDER BY asset.created_at DESC, asset.id DESC;
END;
$$;

CREATE FUNCTION public.configure_character_media_asset_paid_open(
  _asset_id UUID,
  _price_credits INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _asset public.character_media_assets%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF _price_credits IS NOT NULL AND _price_credits <= 0 THEN RAISE EXCEPTION 'invalid_paid_open_price'; END IF;
  SELECT * INTO _asset FROM public.character_media_assets asset WHERE asset.id = _asset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_asset_not_found'; END IF;
  IF _asset.ingest_status <> 'ready' OR _asset.status NOT IN ('available', 'restored') THEN
    RAISE EXCEPTION 'media_asset_not_paid_open_configurable';
  END IF;
  UPDATE public.character_media_assets
  SET paid_open_price_credits = _price_credits, updated_at = clock_timestamp(), updated_by_user_id = auth.uid()
  WHERE id = _asset.id;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), CASE WHEN _price_credits IS NULL THEN 'character_media_asset.paid_open_disabled' ELSE 'character_media_asset.paid_open_configured' END,
    'character_media_asset', _asset.id::TEXT, jsonb_build_object('price_credits', _price_credits));
  RETURN jsonb_build_object('asset_id', _asset.id, 'paid_open_price_credits', _price_credits);
END;
$$;

REVOKE ALL ON FUNCTION private.resolve_paid_attachment_payout_operator(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.consume_paid_attachment_open_rate_limit(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_paid_message_attachment(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_paid_message_attachment_session(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.configure_character_media_asset_paid_open(UUID, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_operator_media_message(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_message_attachment_access(UUID[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_operator_media_catalog(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admin_media_catalog(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admin_character_media_assets(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_paid_message_attachment(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_paid_message_attachment_session(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.configure_character_media_asset_paid_open(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_operator_media_message(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_message_attachment_access(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_operator_media_catalog(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_media_catalog(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_character_media_assets(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

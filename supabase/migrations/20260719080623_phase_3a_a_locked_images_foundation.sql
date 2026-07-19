-- Phase 3A-A: locked-image database and RPC foundation.
-- No UI, Edge deployment, or derivative generation is introduced in this migration.

ALTER TABLE public.character_media_assets
  ADD COLUMN locked_price_credits INTEGER,
  ADD COLUMN locked_teaser_path TEXT,
  ADD COLUMN locked_delivery_path TEXT,
  ADD COLUMN locked_derivatives_generated_at TIMESTAMPTZ,
  ADD COLUMN locked_derivative_error_code TEXT,
  ADD CONSTRAINT character_media_assets_locked_price_check
    CHECK (locked_price_credits IS NULL OR locked_price_credits > 0),
  ADD CONSTRAINT character_media_assets_locked_derivatives_check
    CHECK (
      (
        locked_teaser_path IS NULL
        AND locked_delivery_path IS NULL
        AND locked_derivatives_generated_at IS NULL
      )
      OR (
        locked_teaser_path IS NOT NULL
        AND locked_delivery_path IS NOT NULL
        AND locked_derivatives_generated_at IS NOT NULL
      )
    ),
  ADD CONSTRAINT character_media_assets_locked_eligibility_check
    CHECK (
      locked_price_credits IS NULL
      OR (
        locked_teaser_path IS NOT NULL
        AND locked_delivery_path IS NOT NULL
        AND locked_derivatives_generated_at IS NOT NULL
      )
    );

CREATE INDEX character_media_assets_locked_eligible_idx
  ON public.character_media_assets (character_id, created_at DESC)
  WHERE locked_price_credits IS NOT NULL
    AND ingest_status = 'ready'
    AND status IN ('available', 'restored');

ALTER TABLE public.message_attachments
  ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'standard'
    CHECK (access_mode IN ('standard', 'locked')),
  ADD COLUMN price_credits_snapshot INTEGER;

ALTER TABLE public.message_attachments
  ADD CONSTRAINT message_attachments_locked_price_snapshot_check
    CHECK (
      (access_mode = 'standard' AND price_credits_snapshot IS NULL)
      OR (access_mode = 'locked' AND price_credits_snapshot > 0)
    );

CREATE INDEX message_attachments_locked_idx
  ON public.message_attachments (id)
  WHERE access_mode = 'locked';

ALTER TABLE public.credit_transactions
  ADD COLUMN message_attachment_id UUID
    REFERENCES public.message_attachments(id) ON DELETE RESTRICT;

ALTER TABLE public.credit_transactions
  DROP CONSTRAINT credit_transactions_type_check,
  ADD CONSTRAINT credit_transactions_type_check
    CHECK (
      type IN (
        'signup_bonus',
        'message_spend',
        'admin_adjustment',
        'package_purchase',
        'reset_grant',
        'migration_backfill',
        'locked_image_unlock',
        'locked_image_refund'
      )
    ),
  ADD CONSTRAINT credit_transactions_locked_attachment_check
    CHECK (
      type NOT IN ('locked_image_unlock', 'locked_image_refund')
      OR message_attachment_id IS NOT NULL
    );

CREATE INDEX credit_transactions_message_attachment_idx
  ON public.credit_transactions (message_attachment_id, created_at DESC)
  WHERE message_attachment_id IS NOT NULL;

CREATE UNIQUE INDEX credit_transactions_one_locked_unlock_idx
  ON public.credit_transactions (user_id, message_attachment_id)
  WHERE type = 'locked_image_unlock';

CREATE TABLE public.message_attachment_unlocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id UUID NOT NULL REFERENCES public.message_attachments(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  charged_transaction_id UUID NOT NULL UNIQUE REFERENCES public.credit_transactions(id) ON DELETE RESTRICT,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  refunded_at TIMESTAMPTZ,
  refund_transaction_id UUID UNIQUE REFERENCES public.credit_transactions(id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (attachment_id, client_id),
  CHECK (
    (refunded_at IS NULL AND refund_transaction_id IS NULL)
    OR (refunded_at IS NOT NULL AND refund_transaction_id IS NOT NULL)
  )
);

CREATE INDEX message_attachment_unlocks_client_idx
  ON public.message_attachment_unlocks (client_id, unlocked_at DESC);

CREATE TABLE private.message_attachment_unlock_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id UUID NOT NULL REFERENCES public.message_attachments(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  idempotency_key UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'succeeded')),
  charged_transaction_id UUID UNIQUE REFERENCES public.credit_transactions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (client_id, idempotency_key),
  UNIQUE (client_id, attachment_id),
  CHECK (
    (status = 'started' AND charged_transaction_id IS NULL)
    OR (status = 'succeeded' AND charged_transaction_id IS NOT NULL)
  )
);

CREATE INDEX message_attachment_unlock_attempts_client_created_idx
  ON private.message_attachment_unlock_attempts (client_id, created_at DESC);

ALTER TABLE public.message_attachment_unlocks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_attachment_unlocks FROM PUBLIC, anon, authenticated;

INSERT INTO public.system_settings (key, value)
VALUES ('locked_images_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.configure_character_media_asset_locked(
  _asset_id UUID,
  _price_credits INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _asset public.character_media_assets%ROWTYPE;
BEGIN
  IF _user_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF NOT private.setting_bool('locked_images_enabled', false) THEN
    RAISE EXCEPTION 'locked_images_disabled';
  END IF;

  SELECT * INTO _asset
  FROM public.character_media_assets asset
  WHERE asset.id = _asset_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_asset_not_found';
  END IF;

  IF _asset.ingest_status <> 'ready' OR _asset.status NOT IN ('available', 'restored') THEN
    RAISE EXCEPTION 'media_asset_not_locked_configurable';
  END IF;

  IF _price_credits IS NOT NULL AND _price_credits <= 0 THEN
    RAISE EXCEPTION 'invalid_locked_image_price';
  END IF;

  IF _price_credits IS NOT NULL
    AND (
      _asset.locked_teaser_path IS NULL
      OR _asset.locked_delivery_path IS NULL
      OR _asset.locked_derivatives_generated_at IS NULL
    ) THEN
    RAISE EXCEPTION 'locked_derivatives_not_ready';
  END IF;

  UPDATE public.character_media_assets
  SET
    locked_price_credits = _price_credits,
    updated_by_user_id = _user_id
  WHERE id = _asset.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _user_id,
    CASE WHEN _price_credits IS NULL THEN 'character_media_asset.locked_disabled' ELSE 'character_media_asset.locked_configured' END,
    'character_media_asset',
    _asset.id::TEXT,
    jsonb_build_object('price_credits', _price_credits)
  );

  RETURN jsonb_build_object(
    'asset_id', _asset.id,
    'locked_price_credits', _price_credits,
    'locked_ready', _price_credits IS NOT NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_message_attachment_access(
  _attachment_ids UUID[]
)
RETURNS TABLE (
  attachment_id UUID,
  access_mode TEXT,
  render_state TEXT,
  price_credits_snapshot INTEGER,
  is_unlocked BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _locked_images_enabled BOOLEAN := private.setting_bool('locked_images_enabled', false);
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF _attachment_ids IS NULL OR cardinality(_attachment_ids) = 0 THEN
    RETURN;
  END IF;

  IF cardinality(_attachment_ids) > 100 THEN
    RAISE EXCEPTION 'too_many_attachment_ids';
  END IF;

  RETURN QUERY
  SELECT
    attachment.id,
    attachment.access_mode,
    CASE
      WHEN attachment.access_mode = 'standard' THEN 'standard'
      WHEN NOT _locked_images_enabled THEN 'disabled'
      WHEN conversation.client_id = _user_id
        AND EXISTS (
          SELECT 1
          FROM public.message_attachment_unlocks unlock
          WHERE unlock.attachment_id = attachment.id
            AND unlock.client_id = _user_id
            AND unlock.revoked_at IS NULL
        ) THEN 'delivery'
      WHEN conversation.client_id = _user_id THEN 'teaser'
      ELSE 'delivery'
    END AS render_state,
    CASE
      WHEN conversation.client_id = _user_id AND attachment.access_mode = 'locked'
      THEN attachment.price_credits_snapshot
      ELSE NULL
    END AS price_credits_snapshot,
    CASE
      WHEN conversation.client_id = _user_id AND attachment.access_mode = 'locked'
      THEN EXISTS (
        SELECT 1
        FROM public.message_attachment_unlocks unlock
        WHERE unlock.attachment_id = attachment.id
          AND unlock.client_id = _user_id
          AND unlock.revoked_at IS NULL
      )
      ELSE NULL
    END AS is_unlocked
  FROM public.message_attachments attachment
  JOIN public.messages message ON message.id = attachment.message_id
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
  WHERE attachment.id = ANY (_attachment_ids)
    AND (
      conversation.client_id = _user_id
      OR EXISTS (
        SELECT 1
        FROM public.character_operator_assignments assignment
        JOIN public.operators operator ON operator.id = assignment.operator_id
        WHERE assignment.character_id = conversation.character_id
          AND operator.user_id = _user_id
          AND operator.is_active = TRUE
      )
      OR EXISTS (
        SELECT 1
        FROM public.user_roles role
        WHERE role.user_id = _user_id
          AND role.role = 'admin'
      )
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.send_operator_locked_media_message(
  _reservation_id UUID,
  _caption TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _caption_clean TEXT := NULLIF(btrim(COALESCE(_caption, '')), '');
  _conversation_id UUID;
  _asset_id UUID;
  _reservation public.character_media_reservations%ROWTYPE;
  _asset public.character_media_assets%ROWTYPE;
  _guard RECORD;
  _message_result RECORD;
  _attachment public.message_attachments%ROWTYPE;
  _message JSONB;
BEGIN
  IF NOT private.setting_bool('locked_images_enabled', false) THEN
    RAISE EXCEPTION 'locked_images_disabled';
  END IF;

  IF _caption_clean IS NOT NULL AND char_length(_caption_clean) > 1000 THEN
    RAISE EXCEPTION 'invalid_media_caption';
  END IF;

  SELECT reservation.conversation_id, reservation.media_asset_id
  INTO _conversation_id, _asset_id
  FROM public.character_media_reservations reservation
  WHERE reservation.id = _reservation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_reservation_not_found';
  END IF;

  SELECT * INTO _guard
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);

  PERFORM private.expire_character_media_reservations(NULL, _asset_id);

  SELECT * INTO _asset
  FROM public.character_media_assets asset
  WHERE asset.id = _asset_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_asset_not_found';
  END IF;

  SELECT * INTO _reservation
  FROM public.character_media_reservations reservation
  WHERE reservation.id = _reservation_id
  FOR UPDATE;

  IF _reservation.operator_id <> _guard.operator_id THEN
    RAISE EXCEPTION 'media_reservation_not_owned';
  END IF;

  IF _reservation.state = 'consumed' THEN
    SELECT to_jsonb(message)
    INTO _message
    FROM public.message_attachments attachment
    JOIN public.messages message ON message.id = attachment.message_id
    WHERE attachment.reservation_id = _reservation.id
      AND attachment.access_mode = 'locked';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'media_reservation_consumed_with_different_access_mode';
    END IF;

    RETURN jsonb_build_object('message', _message, 'already_sent', TRUE, 'concurrency_mode', _guard.concurrency_mode);
  END IF;

  IF _reservation.state = 'released' THEN
    RAISE EXCEPTION 'media_reservation_released';
  ELSIF _reservation.state = 'expired' THEN
    RAISE EXCEPTION 'media_reservation_expired';
  ELSIF _reservation.state <> 'active' THEN
    RAISE EXCEPTION 'media_reservation_not_active';
  END IF;

  IF _asset.status <> 'reserved' THEN
    RAISE EXCEPTION 'media_asset_not_reserved';
  END IF;

  IF _asset.ingest_status <> 'ready' THEN
    RAISE EXCEPTION 'media_asset_not_ready';
  END IF;

  IF _asset.locked_price_credits IS NULL
    OR _asset.locked_teaser_path IS NULL
    OR _asset.locked_delivery_path IS NULL
    OR _asset.locked_derivatives_generated_at IS NULL THEN
    RAISE EXCEPTION 'locked_media_asset_not_ready';
  END IF;

  SELECT * INTO _message_result
  FROM private.create_operator_message_with_scoring(
    _conversation_id,
    _guard.operator_id,
    _guard.user_id,
    COALESCE(_caption_clean, '[image]'),
    jsonb_build_object(
      'source', 'send_operator_locked_media_message',
      'attachment_kind', 'image',
      'access_mode', 'locked'
    )
  );

  INSERT INTO public.message_attachments (
    message_id,
    media_asset_id,
    reservation_id,
    kind,
    position,
    caption,
    access_mode,
    price_credits_snapshot
  )
  VALUES (
    _message_result.message_id,
    _asset.id,
    _reservation.id,
    'image',
    0,
    _caption_clean,
    'locked',
    _asset.locked_price_credits
  )
  RETURNING * INTO _attachment;

  UPDATE public.character_media_reservations
  SET
    state = 'consumed',
    ended_at = clock_timestamp(),
    ended_by_user_id = _guard.user_id,
    ended_reason = 'sent'
  WHERE id = _reservation.id;

  UPDATE public.character_media_assets
  SET
    status = 'sent',
    updated_by_user_id = _guard.user_id
  WHERE id = _asset.id
    AND status = 'reserved';

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES
    (
      _guard.user_id,
      'character_media_reservation.consumed',
      'character_media_reservation',
      _reservation.id::TEXT,
      jsonb_build_object('media_asset_id', _asset.id, 'message_id', _message_result.message_id, 'access_mode', 'locked')
    ),
    (
      _guard.user_id,
      'message_attachment.created',
      'message_attachment',
      _attachment.id::TEXT,
      jsonb_build_object('message_id', _message_result.message_id, 'kind', 'image', 'access_mode', 'locked')
    );

  RETURN jsonb_build_object(
    'message', _message_result.message,
    'attachment', jsonb_build_object(
      'id', _attachment.id,
      'message_id', _attachment.message_id,
      'kind', _attachment.kind,
      'position', _attachment.position,
      'caption', _attachment.caption,
      'metadata', _attachment.metadata,
      'created_at', _attachment.created_at,
      'access_mode', _attachment.access_mode
    ),
    'already_sent', FALSE,
    'score_awarded', _message_result.score_awarded,
    'streak_position', _message_result.streak_position,
    'consecutive_message_limit', _message_result.consecutive_message_limit,
    'monthly_points', _message_result.monthly_points,
    'scoring_enabled', _message_result.scoring_enabled,
    'concurrency_mode', _guard.concurrency_mode
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.unlock_locked_message_attachment(
  _attachment_id UUID,
  _idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _client_id UUID := auth.uid();
  _attachment RECORD;
  _attempt private.message_attachment_unlock_attempts%ROWTYPE;
  _existing_attempt private.message_attachment_unlock_attempts%ROWTYPE;
  _wallet_balance INTEGER;
  _balance_after INTEGER;
  _transaction public.credit_transactions%ROWTYPE;
  _unlock public.message_attachment_unlocks%ROWTYPE;
BEGIN
  IF _client_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF _idempotency_key IS NULL THEN
    RAISE EXCEPTION 'idempotency_key_required';
  END IF;

  IF NOT private.setting_bool('locked_images_enabled', false) THEN
    RAISE EXCEPTION 'locked_images_disabled';
  END IF;

  SELECT
    attachment.id,
    attachment.message_id,
    attachment.price_credits_snapshot,
    conversation.client_id,
    asset.status AS asset_status,
    asset.locked_teaser_path,
    asset.locked_delivery_path,
    asset.locked_derivatives_generated_at
  INTO _attachment
  FROM public.message_attachments attachment
  JOIN public.messages message ON message.id = attachment.message_id
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
  JOIN public.character_media_assets asset ON asset.id = attachment.media_asset_id
  WHERE attachment.id = _attachment_id
    AND attachment.access_mode = 'locked';

  IF NOT FOUND OR _attachment.client_id <> _client_id THEN
    RAISE EXCEPTION 'locked_attachment_not_available';
  END IF;

  IF _attachment.asset_status = 'disabled'
    OR _attachment.locked_teaser_path IS NULL
    OR _attachment.locked_delivery_path IS NULL
    OR _attachment.locked_derivatives_generated_at IS NULL THEN
    RAISE EXCEPTION 'locked_attachment_not_available';
  END IF;

  INSERT INTO private.message_attachment_unlock_attempts (
    attachment_id,
    client_id,
    idempotency_key
  )
  VALUES (_attachment_id, _client_id, _idempotency_key)
  ON CONFLICT DO NOTHING
  RETURNING * INTO _attempt;

  IF NOT FOUND THEN
    SELECT * INTO _existing_attempt
    FROM private.message_attachment_unlock_attempts attempt
    WHERE attempt.client_id = _client_id
      AND (attempt.idempotency_key = _idempotency_key OR attempt.attachment_id = _attachment_id)
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'unlock_attempt_not_found';
    END IF;

    IF _existing_attempt.idempotency_key <> _idempotency_key
      OR _existing_attempt.attachment_id <> _attachment_id THEN
      RAISE EXCEPTION 'idempotency_key_reused';
    END IF;

    IF _existing_attempt.status <> 'succeeded' OR _existing_attempt.charged_transaction_id IS NULL THEN
      RAISE EXCEPTION 'unlock_attempt_in_progress';
    END IF;

    SELECT unlock.* INTO _unlock
    FROM public.message_attachment_unlocks unlock
    WHERE unlock.charged_transaction_id = _existing_attempt.charged_transaction_id;

    SELECT credit_transaction.balance_after INTO _balance_after
    FROM public.credit_transactions credit_transaction
    WHERE credit_transaction.id = _existing_attempt.charged_transaction_id;

    IF NOT FOUND OR _unlock.id IS NULL THEN
      RAISE EXCEPTION 'unlock_attempt_invariant_failed';
    END IF;

    RETURN jsonb_build_object(
      'attachment_id', _attachment_id,
      'already_unlocked', TRUE,
      'balance', _balance_after,
      'unlocked_at', _unlock.unlocked_at
    );
  END IF;

  INSERT INTO public.credit_wallets (user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_client_id, 0, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT wallet.balance INTO _wallet_balance
  FROM public.credit_wallets wallet
  WHERE wallet.user_id = _client_id
  FOR UPDATE;

  IF _wallet_balance < _attachment.price_credits_snapshot THEN
    RAISE EXCEPTION 'insufficient_credits';
  END IF;

  UPDATE public.credit_wallets
  SET
    balance = balance - _attachment.price_credits_snapshot,
    lifetime_spent = lifetime_spent + _attachment.price_credits_snapshot
  WHERE user_id = _client_id
  RETURNING balance INTO _balance_after;

  INSERT INTO public.credit_transactions (
    user_id,
    amount,
    balance_after,
    type,
    reason,
    message_id,
    message_attachment_id,
    metadata
  )
  VALUES (
    _client_id,
    -_attachment.price_credits_snapshot,
    _balance_after,
    'locked_image_unlock',
    'locked_image_unlock',
    _attachment.message_id,
    _attachment.id,
    jsonb_build_object('price_credits_snapshot', _attachment.price_credits_snapshot)
  )
  RETURNING * INTO _transaction;

  INSERT INTO public.message_attachment_unlocks (
    attachment_id,
    client_id,
    charged_transaction_id
  )
  VALUES (
    _attachment.id,
    _client_id,
    _transaction.id
  )
  RETURNING * INTO _unlock;

  UPDATE private.message_attachment_unlock_attempts
  SET
    status = 'succeeded',
    charged_transaction_id = _transaction.id,
    updated_at = clock_timestamp()
  WHERE id = _attempt.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _client_id,
    'message_attachment.unlocked',
    'message_attachment',
    _attachment.id::TEXT,
    jsonb_build_object('transaction_id', _transaction.id, 'price_credits_snapshot', _attachment.price_credits_snapshot)
  );

  RETURN jsonb_build_object(
    'attachment_id', _attachment.id,
    'already_unlocked', FALSE,
    'balance', _balance_after,
    'unlocked_at', _unlock.unlocked_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_character_media_preview_path_for_server(
  _actor_user_id UUID,
  _target_kind TEXT,
  _target_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _resolved_path TEXT;
  _concurrency_mode TEXT;
  _locked_images_enabled BOOLEAN := private.setting_bool('locked_images_enabled', false);
  _access_mode TEXT;
  _is_client BOOLEAN;
  _is_operator BOOLEAN;
  _is_admin BOOLEAN;
BEGIN
  IF _actor_user_id IS NULL OR _target_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF _target_kind = 'admin_asset_preview' THEN
    SELECT asset.preview_path
    INTO _resolved_path
    FROM public.character_media_assets asset
    WHERE asset.id = _target_id
      AND asset.bucket_id = 'character-media'
      AND asset.ingest_status = 'ready'
      AND asset.preview_generated_at IS NOT NULL
      AND asset.preview_path IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.user_roles role
        WHERE role.user_id = _actor_user_id AND role.role = 'admin'
      );

    RETURN _resolved_path;
  END IF;

  IF _target_kind = 'message_attachment' THEN
    SELECT
      attachment.access_mode,
      conversation.client_id = _actor_user_id,
      EXISTS (
        SELECT 1
        FROM public.character_operator_assignments assignment
        JOIN public.operators operator ON operator.id = assignment.operator_id
        WHERE assignment.character_id = conversation.character_id
          AND operator.user_id = _actor_user_id
          AND operator.is_active = TRUE
      ),
      EXISTS (
        SELECT 1
        FROM public.user_roles role
        WHERE role.user_id = _actor_user_id
          AND role.role = 'admin'
      )
    INTO _access_mode, _is_client, _is_operator, _is_admin
    FROM public.message_attachments attachment
    JOIN public.messages message ON message.id = attachment.message_id
    JOIN public.conversations conversation ON conversation.id = message.conversation_id
    JOIN public.character_media_assets asset ON asset.id = attachment.media_asset_id
    WHERE attachment.id = _target_id
      AND asset.bucket_id = 'character-media'
      AND asset.ingest_status = 'ready'
      AND (
        conversation.client_id = _actor_user_id
        OR EXISTS (
          SELECT 1
          FROM public.character_operator_assignments assignment
          JOIN public.operators operator ON operator.id = assignment.operator_id
          WHERE assignment.character_id = conversation.character_id
            AND operator.user_id = _actor_user_id
            AND operator.is_active = TRUE
        )
        OR EXISTS (
          SELECT 1
          FROM public.user_roles role
          WHERE role.user_id = _actor_user_id
            AND role.role = 'admin'
        )
      );

    IF NOT FOUND THEN
      RETURN NULL;
    END IF;

    IF _access_mode = 'standard' THEN
      SELECT asset.preview_path INTO _resolved_path
      FROM public.message_attachments attachment
      JOIN public.character_media_assets asset ON asset.id = attachment.media_asset_id
      WHERE attachment.id = _target_id
        AND asset.preview_generated_at IS NOT NULL
        AND asset.preview_path IS NOT NULL;

      RETURN _resolved_path;
    END IF;

    IF NOT _locked_images_enabled THEN
      RETURN NULL;
    END IF;

    IF _is_client THEN
      IF EXISTS (
        SELECT 1
        FROM public.message_attachment_unlocks unlock
        WHERE unlock.attachment_id = _target_id
          AND unlock.client_id = _actor_user_id
          AND unlock.revoked_at IS NULL
      ) THEN
        SELECT asset.locked_delivery_path INTO _resolved_path
        FROM public.message_attachments attachment
        JOIN public.character_media_assets asset ON asset.id = attachment.media_asset_id
        WHERE attachment.id = _target_id
          AND asset.status <> 'disabled'
          AND asset.locked_delivery_path IS NOT NULL
          AND asset.locked_derivatives_generated_at IS NOT NULL;
      ELSE
        SELECT asset.locked_teaser_path INTO _resolved_path
        FROM public.message_attachments attachment
        JOIN public.character_media_assets asset ON asset.id = attachment.media_asset_id
        WHERE attachment.id = _target_id
          AND asset.status <> 'disabled'
          AND asset.locked_teaser_path IS NOT NULL
          AND asset.locked_derivatives_generated_at IS NOT NULL;
      END IF;

      RETURN _resolved_path;
    END IF;

    IF _is_operator OR _is_admin THEN
      SELECT asset.locked_delivery_path INTO _resolved_path
      FROM public.message_attachments attachment
      JOIN public.character_media_assets asset ON asset.id = attachment.media_asset_id
      WHERE attachment.id = _target_id
        AND asset.status <> 'disabled'
        AND asset.locked_delivery_path IS NOT NULL
        AND asset.locked_derivatives_generated_at IS NOT NULL;

      RETURN _resolved_path;
    END IF;

    RETURN NULL;
  END IF;

  IF _target_kind = 'reserved_preview' THEN
    SELECT setting.value INTO _concurrency_mode
    FROM public.system_settings setting
    WHERE setting.key = 'concurrency_mode';

    SELECT asset.preview_path
    INTO _resolved_path
    FROM public.character_media_reservations reservation
    JOIN public.character_media_assets asset ON asset.id = reservation.media_asset_id
    JOIN public.conversations conversation ON conversation.id = reservation.conversation_id
    WHERE reservation.id = _target_id
      AND reservation.state = 'active'
      AND reservation.expires_at > clock_timestamp()
      AND conversation.status <> 'closed'
      AND asset.bucket_id = 'character-media'
      AND asset.ingest_status = 'ready'
      AND asset.preview_generated_at IS NOT NULL
      AND asset.preview_path IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM public.user_roles role
          WHERE role.user_id = _actor_user_id AND role.role = 'admin'
        )
        OR EXISTS (
          SELECT 1
          FROM public.operators operator
          JOIN public.character_operator_assignments assignment
            ON assignment.operator_id = operator.id
           AND assignment.character_id = conversation.character_id
          WHERE operator.id = reservation.operator_id
            AND operator.user_id = _actor_user_id
            AND operator.is_active = TRUE
            AND reservation.reserved_by_user_id = _actor_user_id
        )
      )
      AND (
        COALESCE(_concurrency_mode, 'open') <> 'lock'
        OR NOT EXISTS (
          SELECT 1
          FROM public.conversation_locks conversation_lock
          WHERE conversation_lock.conversation_id = conversation.id
            AND conversation_lock.released_at IS NULL
            AND conversation_lock.expires_at > clock_timestamp()
            AND conversation_lock.locked_by_operator_id <> reservation.operator_id
        )
      );

    RETURN _resolved_path;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.configure_character_media_asset_locked(UUID, INTEGER)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_message_attachment_access(UUID[])
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_operator_locked_media_message(UUID, TEXT)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unlock_locked_message_attachment(UUID, UUID)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_character_media_preview_path_for_server(UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.configure_character_media_asset_locked(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_message_attachment_access(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_operator_locked_media_message(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_locked_message_attachment(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_character_media_preview_path_for_server(UUID, TEXT, UUID) TO service_role;

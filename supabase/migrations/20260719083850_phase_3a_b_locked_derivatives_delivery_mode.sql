-- Phase 3A-B: locked-image derivative processing and explicit reservation delivery intent.
-- The feature flag remains disabled by default; this migration only prepares guarded contracts.

ALTER TABLE public.character_media_assets
  ADD COLUMN locked_derivative_status TEXT NOT NULL DEFAULT 'not_requested'
    CHECK (locked_derivative_status IN ('not_requested', 'processing', 'ready', 'failed')),
  ADD COLUMN locked_derivative_processing_started_at TIMESTAMPTZ,
  ADD COLUMN locked_derivative_processing_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN locked_derivative_completed_at TIMESTAMPTZ,
  ADD CONSTRAINT character_media_assets_locked_derivative_state_check
    CHECK (
      (locked_derivative_status = 'ready') = (
        locked_teaser_path IS NOT NULL
        AND locked_delivery_path IS NOT NULL
        AND locked_derivatives_generated_at IS NOT NULL
      )
    ),
  ADD CONSTRAINT character_media_assets_locked_derivative_error_check
    CHECK (
      (locked_derivative_status = 'failed') = (locked_derivative_error_code IS NOT NULL)
    );

ALTER TABLE public.character_media_reservations
  ADD COLUMN intended_access_mode TEXT NOT NULL DEFAULT 'standard'
    CHECK (intended_access_mode IN ('standard', 'locked'));

CREATE INDEX character_media_reservations_active_delivery_mode_idx
  ON public.character_media_reservations (media_asset_id, intended_access_mode)
  WHERE state = 'active';

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

  IF _price_credits IS NOT NULL AND _asset.locked_derivative_status <> 'ready' THEN
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

CREATE FUNCTION public.begin_locked_media_derivative_processing_for_server(
  _actor_user_id UUID,
  _asset_id UUID
)
RETURNS TABLE (
  asset_id UUID,
  source_path TEXT,
  locked_teaser_path TEXT,
  locked_delivery_path TEXT,
  content_type TEXT,
  already_ready BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _asset public.character_media_assets%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' OR _actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles role
    WHERE role.user_id = _actor_user_id AND role.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  SELECT * INTO _asset
  FROM public.character_media_assets asset
  WHERE asset.id = _asset_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_asset_not_found';
  END IF;

  IF _asset.ingest_status <> 'ready' OR _asset.status NOT IN ('available', 'restored') THEN
    RAISE EXCEPTION 'media_asset_not_locked_processable';
  END IF;

  IF _asset.locked_derivative_status = 'ready' THEN
    RETURN QUERY SELECT _asset.id, NULL::TEXT, NULL::TEXT, NULL::TEXT, _asset.content_type, TRUE;
    RETURN;
  END IF;

  IF _asset.locked_derivative_status = 'processing'
    AND _asset.locked_derivative_processing_started_at > clock_timestamp() - INTERVAL '10 minutes' THEN
    RAISE EXCEPTION 'locked_derivative_processing_in_progress';
  END IF;

  UPDATE public.character_media_assets
  SET
    locked_derivative_status = 'processing',
    locked_derivative_processing_started_at = clock_timestamp(),
    locked_derivative_processing_by_user_id = _actor_user_id,
    locked_derivative_completed_at = NULL,
    locked_derivative_error_code = NULL,
    updated_by_user_id = _actor_user_id
  WHERE id = _asset.id
  RETURNING * INTO _asset;

  RETURN QUERY
  SELECT
    _asset.id,
    _asset.source_path,
    format('characters/%s/assets/%s/locked/teaser.webp', _asset.character_id, _asset.id),
    format('characters/%s/assets/%s/locked/delivery.webp', _asset.character_id, _asset.id),
    _asset.content_type,
    FALSE;
END;
$$;

CREATE FUNCTION public.finalize_locked_media_derivatives_for_server(
  _actor_user_id UUID,
  _asset_id UUID,
  _locked_teaser_path TEXT,
  _locked_delivery_path TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _asset public.character_media_assets%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' OR _actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles role
    WHERE role.user_id = _actor_user_id AND role.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  SELECT * INTO _asset
  FROM public.character_media_assets asset
  WHERE asset.id = _asset_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_asset_not_found';
  END IF;

  IF _asset.locked_derivative_status = 'ready' THEN
    RETURN jsonb_build_object('asset_id', _asset.id, 'locked_derivative_status', 'ready', 'already_ready', TRUE);
  END IF;

  IF _asset.status NOT IN ('available', 'restored')
    OR _asset.ingest_status <> 'ready'
    OR _asset.locked_derivative_status <> 'processing'
    OR _locked_teaser_path !~ '^characters/[0-9a-f-]+/assets/[0-9a-f-]+/locked/teaser\\.webp$'
    OR _locked_delivery_path !~ '^characters/[0-9a-f-]+/assets/[0-9a-f-]+/locked/delivery\\.webp$'
    OR NOT EXISTS (
      SELECT 1 FROM storage.objects object
      WHERE object.bucket_id = _asset.bucket_id AND object.name = _locked_teaser_path
    )
    OR NOT EXISTS (
      SELECT 1 FROM storage.objects object
      WHERE object.bucket_id = _asset.bucket_id AND object.name = _locked_delivery_path
    ) THEN
    RAISE EXCEPTION 'locked_derivative_finalize_invalid';
  END IF;

  UPDATE public.character_media_assets
  SET
    locked_teaser_path = _locked_teaser_path,
    locked_delivery_path = _locked_delivery_path,
    locked_derivatives_generated_at = clock_timestamp(),
    locked_derivative_status = 'ready',
    locked_derivative_processing_started_at = NULL,
    locked_derivative_processing_by_user_id = NULL,
    locked_derivative_completed_at = clock_timestamp(),
    locked_derivative_error_code = NULL,
    updated_by_user_id = _actor_user_id
  WHERE id = _asset.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _actor_user_id,
    'character_media_asset.locked_derivatives_ready',
    'character_media_asset',
    _asset.id::TEXT,
    '{}'::jsonb
  );

  RETURN jsonb_build_object('asset_id', _asset.id, 'locked_derivative_status', 'ready', 'already_ready', FALSE);
END;
$$;

CREATE FUNCTION public.fail_locked_media_derivative_processing_for_server(
  _actor_user_id UUID,
  _asset_id UUID,
  _error_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _asset public.character_media_assets%ROWTYPE;
  _safe_error_code TEXT := lower(btrim(COALESCE(_error_code, 'locked_derivative_processing_failed')));
BEGIN
  IF auth.role() <> 'service_role' OR _actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles role
    WHERE role.user_id = _actor_user_id AND role.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF _safe_error_code !~ '^[a-z0-9_]{1,64}$' THEN
    _safe_error_code := 'locked_derivative_processing_failed';
  END IF;

  SELECT * INTO _asset
  FROM public.character_media_assets asset
  WHERE asset.id = _asset_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_asset_not_found';
  END IF;

  IF _asset.locked_derivative_status = 'ready' THEN
    RETURN jsonb_build_object('asset_id', _asset.id, 'locked_derivative_status', 'ready', 'already_ready', TRUE);
  END IF;

  UPDATE public.character_media_assets
  SET
    locked_derivative_status = 'failed',
    locked_derivative_processing_started_at = NULL,
    locked_derivative_processing_by_user_id = NULL,
    locked_derivative_completed_at = NULL,
    locked_derivative_error_code = _safe_error_code,
    updated_by_user_id = _actor_user_id
  WHERE id = _asset.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _actor_user_id,
    'character_media_asset.locked_derivatives_failed',
    'character_media_asset',
    _asset.id::TEXT,
    jsonb_build_object('error_code', _safe_error_code)
  );

  RETURN jsonb_build_object('asset_id', _asset.id, 'locked_derivative_status', 'failed', 'error_code', _safe_error_code);
END;
$$;

CREATE FUNCTION private.reserve_character_media_for_delivery(
  _conversation_id UUID,
  _asset_id UUID,
  _intended_access_mode TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _guard RECORD;
  _asset public.character_media_assets%ROWTYPE;
  _reservation public.character_media_reservations%ROWTYPE;
  _expires_at TIMESTAMPTZ := clock_timestamp() + INTERVAL '5 minutes';
BEGIN
  IF _intended_access_mode NOT IN ('standard', 'locked') THEN
    RAISE EXCEPTION 'invalid_media_access_mode';
  END IF;

  SELECT * INTO _guard
  FROM private.assert_operator_can_manage_conversation_media(_conversation_id);

  PERFORM private.expire_character_media_reservations(NULL, _asset_id);

  SELECT * INTO _asset
  FROM public.character_media_assets asset
  WHERE asset.id = _asset_id
    AND asset.character_id = _guard.character_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_asset_not_found';
  END IF;

  IF _asset.ingest_status <> 'ready' THEN
    RAISE EXCEPTION 'media_asset_not_ready';
  END IF;

  IF _asset.status NOT IN ('available', 'restored') THEN
    RAISE EXCEPTION 'media_asset_not_reservable';
  END IF;

  IF _intended_access_mode = 'standard' AND _asset.locked_price_credits IS NOT NULL THEN
    RAISE EXCEPTION 'media_asset_requires_locked_delivery';
  END IF;

  IF _intended_access_mode = 'locked' THEN
    IF NOT private.setting_bool('locked_images_enabled', false) THEN
      RAISE EXCEPTION 'locked_images_disabled';
    END IF;

    IF _asset.locked_price_credits IS NULL OR _asset.locked_derivative_status <> 'ready' THEN
      RAISE EXCEPTION 'locked_media_asset_not_ready';
    END IF;
  END IF;

  INSERT INTO public.character_media_reservations (
    media_asset_id,
    conversation_id,
    operator_id,
    reserved_by_user_id,
    previous_asset_status,
    intended_access_mode,
    expires_at
  )
  VALUES (
    _asset.id,
    _conversation_id,
    _guard.operator_id,
    _guard.user_id,
    _asset.status,
    _intended_access_mode,
    _expires_at
  )
  RETURNING * INTO _reservation;

  UPDATE public.character_media_assets
  SET status = 'reserved', updated_by_user_id = _guard.user_id
  WHERE id = _asset.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _guard.user_id,
    'character_media_asset.reserved',
    'character_media_asset',
    _asset.id::TEXT,
    jsonb_build_object(
      'reservation_id', _reservation.id,
      'conversation_id', _conversation_id,
      'expires_at', _expires_at,
      'intended_access_mode', _intended_access_mode
    )
  );

  RETURN jsonb_build_object(
    'reservation_id', _reservation.id,
    'asset_id', _asset.id,
    'expires_at', _expires_at,
    'status', 'reserved',
    'intended_access_mode', _intended_access_mode
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_character_media_asset(
  _conversation_id UUID,
  _asset_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN private.reserve_character_media_for_delivery(_conversation_id, _asset_id, 'standard');
END;
$$;

CREATE FUNCTION public.reserve_character_media_for_delivery(
  _conversation_id UUID,
  _asset_id UUID,
  _intended_access_mode TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN private.reserve_character_media_for_delivery(_conversation_id, _asset_id, _intended_access_mode);
END;
$$;

CREATE FUNCTION private.assert_message_attachment_delivery_mode()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _reservation_mode TEXT;
  _locked_price INTEGER;
BEGIN
  SELECT reservation.intended_access_mode, asset.locked_price_credits
  INTO _reservation_mode, _locked_price
  FROM public.character_media_reservations reservation
  JOIN public.character_media_assets asset ON asset.id = reservation.media_asset_id
  WHERE reservation.id = NEW.reservation_id
    AND reservation.media_asset_id = NEW.media_asset_id;

  IF NOT FOUND OR _reservation_mode <> NEW.access_mode THEN
    RAISE EXCEPTION 'media_reservation_access_mode_mismatch';
  END IF;

  IF NEW.access_mode = 'standard' AND _locked_price IS NOT NULL THEN
    RAISE EXCEPTION 'media_asset_requires_locked_delivery';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS message_attachments_delivery_mode_guard ON public.message_attachments;
CREATE TRIGGER message_attachments_delivery_mode_guard
  BEFORE INSERT ON public.message_attachments
  FOR EACH ROW EXECUTE FUNCTION private.assert_message_attachment_delivery_mode();

DROP FUNCTION IF EXISTS public.get_operator_media_catalog(UUID);
CREATE FUNCTION public.get_operator_media_catalog(
  _conversation_id UUID
)
RETURNS TABLE (
  id UUID,
  display_name TEXT,
  status TEXT,
  ingest_status TEXT,
  content_type TEXT,
  byte_size BIGINT,
  width INTEGER,
  height INTEGER,
  is_reservable BOOLEAN,
  is_locked_reservable BOOLEAN,
  locked_derivative_status TEXT,
  locked_price_credits INTEGER,
  locked_images_enabled BOOLEAN,
  is_reserved_by_me BOOLEAN,
  my_reservation_id UUID,
  my_reservation_expires_at TIMESTAMPTZ,
  my_reservation_access_mode TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _guard RECORD;
  _locked_images_enabled BOOLEAN := private.setting_bool('locked_images_enabled', false);
BEGIN
  SELECT * INTO _guard
  FROM private.assert_operator_can_view_conversation_media(_conversation_id);

  PERFORM private.expire_character_media_reservations(_guard.character_id, NULL);

  RETURN QUERY
  SELECT
    asset.id,
    asset.display_name,
    asset.status,
    asset.ingest_status,
    asset.content_type,
    asset.byte_size,
    asset.width,
    asset.height,
    (
      asset.status IN ('available', 'restored')
      AND asset.ingest_status = 'ready'
      AND asset.locked_price_credits IS NULL
    ) AS is_reservable,
    (
      _locked_images_enabled
      AND asset.status IN ('available', 'restored')
      AND asset.ingest_status = 'ready'
      AND asset.locked_price_credits IS NOT NULL
      AND asset.locked_derivative_status = 'ready'
    ) AS is_locked_reservable,
    asset.locked_derivative_status,
    asset.locked_price_credits,
    _locked_images_enabled,
    COALESCE(reservation.operator_id = _guard.operator_id, FALSE),
    CASE WHEN reservation.operator_id = _guard.operator_id THEN reservation.id END,
    CASE WHEN reservation.operator_id = _guard.operator_id THEN reservation.expires_at END,
    CASE WHEN reservation.operator_id = _guard.operator_id THEN reservation.intended_access_mode END
  FROM public.character_media_assets asset
  LEFT JOIN public.character_media_reservations reservation
    ON reservation.media_asset_id = asset.id
    AND reservation.state = 'active'
  WHERE asset.character_id = _guard.character_id
  ORDER BY asset.created_at DESC, asset.id DESC;
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

  SELECT * INTO _reservation
  FROM public.character_media_reservations reservation
  WHERE reservation.id = _reservation_id
  FOR UPDATE;

  IF _reservation.operator_id <> _guard.operator_id THEN
    RAISE EXCEPTION 'media_reservation_not_owned';
  END IF;

  IF _reservation.intended_access_mode <> 'locked' THEN
    RAISE EXCEPTION 'media_reservation_access_mode_mismatch';
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

  IF _asset.status <> 'reserved'
    OR _asset.ingest_status <> 'ready'
    OR _asset.locked_price_credits IS NULL
    OR _asset.locked_derivative_status <> 'ready' THEN
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
    message_id, media_asset_id, reservation_id, kind, position, caption, access_mode, price_credits_snapshot
  )
  VALUES (
    _message_result.message_id, _asset.id, _reservation.id, 'image', 0, _caption_clean, 'locked', _asset.locked_price_credits
  )
  RETURNING * INTO _attachment;

  UPDATE public.character_media_reservations
  SET state = 'consumed', ended_at = clock_timestamp(), ended_by_user_id = _guard.user_id, ended_reason = 'sent'
  WHERE id = _reservation.id;

  UPDATE public.character_media_assets
  SET status = 'sent', updated_by_user_id = _guard.user_id
  WHERE id = _asset.id AND status = 'reserved';

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES
    (_guard.user_id, 'character_media_reservation.consumed', 'character_media_reservation', _reservation.id::TEXT,
      jsonb_build_object('media_asset_id', _asset.id, 'message_id', _message_result.message_id, 'access_mode', 'locked')),
    (_guard.user_id, 'message_attachment.created', 'message_attachment', _attachment.id::TEXT,
      jsonb_build_object('message_id', _message_result.message_id, 'kind', 'image', 'access_mode', 'locked'));

  RETURN jsonb_build_object(
    'message', _message_result.message,
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

CREATE OR REPLACE FUNCTION public.resolve_character_media_preview_path_for_server(
  _actor_user_id UUID,
  _target_kind TEXT,
  _target_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _path TEXT;
  _concurrency_mode TEXT := COALESCE(private.setting_text('concurrency_mode', 'open'), 'open');
BEGIN
  IF _actor_user_id IS NULL OR _target_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF _target_kind IN ('admin_asset_preview', 'admin_locked_teaser_preview', 'admin_locked_delivery_preview') THEN
    SELECT CASE _target_kind
      WHEN 'admin_asset_preview' THEN asset.preview_path
      WHEN 'admin_locked_teaser_preview' THEN asset.locked_teaser_path
      WHEN 'admin_locked_delivery_preview' THEN asset.locked_delivery_path
    END
    INTO _path
    FROM public.character_media_assets asset
    WHERE asset.id = _target_id
      AND asset.bucket_id = 'character-media'
      AND asset.ingest_status = 'ready'
      AND (
        (_target_kind = 'admin_asset_preview' AND asset.preview_generated_at IS NOT NULL)
        OR (_target_kind IN ('admin_locked_teaser_preview', 'admin_locked_delivery_preview')
          AND asset.locked_derivative_status = 'ready')
      )
      AND EXISTS (
        SELECT 1 FROM public.user_roles role
        WHERE role.user_id = _actor_user_id AND role.role = 'admin'
      );
    RETURN _path;
  END IF;

  IF _target_kind = 'message_attachment' THEN
    SELECT CASE
      WHEN attachment.access_mode = 'standard' THEN asset.preview_path
      WHEN NOT private.setting_bool('locked_images_enabled', false) THEN NULL
      WHEN conversation.client_id = _actor_user_id AND EXISTS (
        SELECT 1 FROM public.message_attachment_unlocks unlock
        WHERE unlock.attachment_id = attachment.id
          AND unlock.client_id = _actor_user_id
          AND unlock.revoked_at IS NULL
      ) THEN asset.locked_delivery_path
      WHEN conversation.client_id = _actor_user_id THEN asset.locked_teaser_path
      ELSE asset.locked_delivery_path
    END
    INTO _path
    FROM public.message_attachments attachment
    JOIN public.messages message ON message.id = attachment.message_id
    JOIN public.conversations conversation ON conversation.id = message.conversation_id
    JOIN public.character_media_assets asset ON asset.id = attachment.media_asset_id
    WHERE attachment.id = _target_id
      AND asset.bucket_id = 'character-media'
      AND asset.ingest_status = 'ready'
      AND asset.status <> 'disabled'
      AND (
        (attachment.access_mode = 'standard' AND asset.preview_generated_at IS NOT NULL)
        OR (attachment.access_mode = 'locked' AND asset.locked_derivative_status = 'ready')
      )
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
          SELECT 1 FROM public.user_roles role
          WHERE role.user_id = _actor_user_id AND role.role = 'admin'
        )
      );
    RETURN _path;
  END IF;

  IF _target_kind = 'reserved_preview' THEN
    SELECT CASE reservation.intended_access_mode
      WHEN 'standard' THEN asset.preview_path
      WHEN 'locked' THEN asset.locked_teaser_path
    END
    INTO _path
    FROM public.character_media_reservations reservation
    JOIN public.character_media_assets asset ON asset.id = reservation.media_asset_id
    JOIN public.conversations conversation ON conversation.id = reservation.conversation_id
    WHERE reservation.id = _target_id
      AND reservation.state = 'active'
      AND reservation.expires_at > clock_timestamp()
      AND conversation.status <> 'closed'
      AND asset.bucket_id = 'character-media'
      AND asset.ingest_status = 'ready'
      AND asset.status = 'reserved'
      AND (
        (reservation.intended_access_mode = 'standard' AND asset.preview_generated_at IS NOT NULL)
        OR (
          reservation.intended_access_mode = 'locked'
          AND private.setting_bool('locked_images_enabled', false)
          AND asset.locked_derivative_status = 'ready'
        )
      )
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
        _concurrency_mode <> 'lock'
        OR NOT EXISTS (
          SELECT 1
          FROM public.conversation_locks conversation_lock
          WHERE conversation_lock.conversation_id = conversation.id
            AND conversation_lock.released_at IS NULL
            AND conversation_lock.expires_at > clock_timestamp()
            AND conversation_lock.locked_by_operator_id <> reservation.operator_id
        )
      );
    RETURN _path;
  END IF;

  RETURN NULL;
END;
$$;

DROP FUNCTION IF EXISTS public.get_admin_character_media_assets(UUID);
CREATE FUNCTION public.get_admin_character_media_assets(
  _character_id UUID
)
RETURNS TABLE (
  id UUID,
  display_name TEXT,
  content_type TEXT,
  byte_size BIGINT,
  width INTEGER,
  height INTEGER,
  status TEXT,
  ingest_status TEXT,
  preview_available BOOLEAN,
  locked_derivative_status TEXT,
  locked_derivatives_generated_at TIMESTAMPTZ,
  locked_derivative_error_code TEXT,
  locked_price_credits INTEGER,
  locked_preview_available BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  disabled_reason TEXT,
  processing_started_at TIMESTAMPTZ,
  processing_attempts INTEGER,
  processing_error_code TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  RETURN QUERY
  SELECT
    asset.id,
    asset.display_name,
    asset.content_type,
    asset.byte_size,
    asset.width,
    asset.height,
    asset.status,
    asset.ingest_status,
    (asset.ingest_status = 'ready' AND asset.preview_generated_at IS NOT NULL),
    asset.locked_derivative_status,
    asset.locked_derivatives_generated_at,
    asset.locked_derivative_error_code,
    asset.locked_price_credits,
    (asset.locked_derivative_status = 'ready'),
    asset.created_at,
    asset.updated_at,
    asset.disabled_at,
    asset.disabled_reason,
    asset.processing_started_at,
    asset.processing_attempts,
    asset.processing_error_code
  FROM public.character_media_assets asset
  WHERE asset.character_id = _character_id
  ORDER BY asset.created_at DESC, asset.id DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_locked_media_derivative_processing_for_server(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_locked_media_derivatives_for_server(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_locked_media_derivative_processing_for_server(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.reserve_character_media_for_delivery(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_message_attachment_delivery_mode()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_character_media_for_delivery(UUID, UUID, TEXT)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_operator_media_catalog(UUID)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admin_character_media_assets(UUID)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.configure_character_media_asset_locked(UUID, INTEGER)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_operator_locked_media_message(UUID, TEXT)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_character_media_preview_path_for_server(UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.begin_locked_media_derivative_processing_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_locked_media_derivatives_for_server(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_locked_media_derivative_processing_for_server(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_character_media_for_delivery(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_operator_media_catalog(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_character_media_assets(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.configure_character_media_asset_locked(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_operator_locked_media_message(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_character_media_preview_path_for_server(UUID, TEXT, UUID) TO service_role;

-- Phase V2-24: free, client-scoped, one-time image viewing for standard media.
-- Locked delivery and its paid/unlock contract remain untouched.

ALTER TABLE public.message_attachments
  ADD COLUMN view_mode TEXT NOT NULL DEFAULT 'permanent',
  ADD COLUMN view_once_opened_at TIMESTAMPTZ,
  ADD COLUMN view_once_completed_at TIMESTAMPTZ,
  ADD CONSTRAINT message_attachments_view_mode_check
    CHECK (view_mode IN ('permanent', 'view_once')),
  ADD CONSTRAINT message_attachments_view_once_state_check
    CHECK (
      (view_mode = 'permanent' AND view_once_opened_at IS NULL AND view_once_completed_at IS NULL)
      OR (view_mode = 'view_once' AND (view_once_completed_at IS NULL OR view_once_opened_at IS NOT NULL))
    ),
  ADD CONSTRAINT message_attachments_view_once_standard_only_check
    CHECK (view_mode = 'permanent' OR access_mode = 'standard');

CREATE INDEX message_attachments_view_once_access_idx
  ON public.message_attachments (message_id, view_mode, view_once_opened_at)
  WHERE view_mode = 'view_once';

-- Admin media remains permanent. The public operator RPC gains an explicit
-- third argument; its former two-argument contract is no longer exposed.
DROP FUNCTION public.send_admin_media_message(UUID, TEXT);
DROP FUNCTION public.send_operator_media_message(UUID, TEXT);
DROP FUNCTION public.get_message_attachment_access(UUID[]);

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
  IF _view_mode_clean NOT IN ('permanent', 'view_once') THEN
    RAISE EXCEPTION 'invalid_media_view_mode';
  END IF;

  SELECT r.conversation_id, r.media_asset_id
  INTO _conversation_id, _asset_id
  FROM public.character_media_reservations r
  WHERE r.id = _reservation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_not_found'; END IF;

  SELECT * INTO _guard
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);
  PERFORM private.expire_character_media_reservations(NULL, _asset_id);

  SELECT * INTO _asset FROM public.character_media_assets a WHERE a.id = _asset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_asset_not_found'; END IF;
  SELECT * INTO _reservation FROM public.character_media_reservations r WHERE r.id = _reservation_id FOR UPDATE;
  IF _reservation.operator_id <> _guard.operator_id THEN RAISE EXCEPTION 'media_reservation_not_owned'; END IF;

  IF _reservation.state = 'consumed' THEN
    SELECT to_jsonb(m) INTO _message
    FROM public.message_attachments ma JOIN public.messages m ON m.id = ma.message_id
    WHERE ma.reservation_id = _reservation.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_consumed_without_attachment'; END IF;

    SELECT jsonb_build_object(
      'message', _message,
      'attachment', jsonb_build_object(
        'id', ma.id, 'message_id', ma.message_id, 'kind', ma.kind, 'position', ma.position,
        'caption', ma.caption, 'metadata', ma.metadata, 'view_mode', ma.view_mode, 'created_at', ma.created_at
      ),
      'already_sent', true, 'concurrency_mode', _guard.concurrency_mode
    ) INTO _idempotent_result
    FROM public.message_attachments ma
    WHERE ma.reservation_id = _reservation.id
      AND ma.view_mode = _view_mode_clean;
    IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_view_mode_conflict'; END IF;
    RETURN _idempotent_result;
  END IF;

  IF _reservation.state = 'released' THEN RAISE EXCEPTION 'media_reservation_released';
  ELSIF _reservation.state = 'expired' THEN RAISE EXCEPTION 'media_reservation_expired';
  ELSIF _reservation.state <> 'active' THEN RAISE EXCEPTION 'media_reservation_not_active';
  END IF;
  IF _asset.status <> 'reserved' THEN RAISE EXCEPTION 'media_asset_not_reserved'; END IF;
  IF _asset.ingest_status <> 'ready' THEN RAISE EXCEPTION 'media_asset_not_ready'; END IF;
  IF _view_mode_clean = 'view_once' AND _reservation.intended_access_mode <> 'standard' THEN
    RAISE EXCEPTION 'view_once_requires_standard_media';
  END IF;

  SELECT * INTO _message_result
  FROM private.create_operator_message_with_scoring(
    _conversation_id, _guard.operator_id, _guard.user_id, COALESCE(_caption_clean, '[image]'),
    jsonb_build_object('source', 'send_operator_media_message', 'attachment_kind', 'image', 'view_mode', _view_mode_clean)
  );

  INSERT INTO public.message_attachments (
    message_id, media_asset_id, reservation_id, kind, position, caption, view_mode
  ) VALUES (
    _message_result.message_id, _asset.id, _reservation.id, 'image', 0, _caption_clean, _view_mode_clean
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

CREATE FUNCTION public.send_admin_media_message(
  _reservation_id UUID,
  _caption TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _reservation public.character_media_reservations%ROWTYPE;
  _guard RECORD;
  _result JSONB;
BEGIN
  SELECT * INTO _reservation FROM public.character_media_reservations r WHERE r.id = _reservation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'media_reservation_not_found'; END IF;
  SELECT * INTO _guard FROM private.assert_admin_can_send_conversation_message(_reservation.conversation_id);
  IF _reservation.operator_id <> _guard.operator_id THEN RAISE EXCEPTION 'media_reservation_not_owned'; END IF;
  SELECT public.send_operator_media_message(_reservation_id, _caption, 'permanent') INTO _result;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_guard.user_id, 'admin_media.message_sent', 'message_attachment',
    COALESCE(_result->'attachment'->>'id', _reservation_id::TEXT),
    jsonb_build_object('actor_kind', 'admin', 'conversation_id', _reservation.conversation_id,
      'reservation_id', _reservation_id, 'already_sent', COALESCE((_result->>'already_sent')::BOOLEAN, FALSE)));
  RETURN _result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_message_attachment_access(_attachment_ids UUID[])
RETURNS TABLE (
  attachment_id UUID,
  access_mode TEXT,
  render_state TEXT,
  price_credits_snapshot INTEGER,
  is_unlocked BOOLEAN,
  view_mode TEXT
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
      WHEN attachment.view_mode = 'view_once' AND conversation.client_id = _user_id
        AND attachment.view_once_opened_at IS NULL THEN 'view_once_available'
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
    CASE WHEN conversation.client_id = _user_id AND attachment.access_mode = 'locked'
      THEN attachment.price_credits_snapshot ELSE NULL END,
    CASE WHEN conversation.client_id = _user_id AND attachment.access_mode = 'locked' THEN EXISTS (
      SELECT 1 FROM public.message_attachment_unlocks unlock
      WHERE unlock.attachment_id = attachment.id AND unlock.client_id = _user_id AND unlock.revoked_at IS NULL
    ) ELSE NULL END,
    attachment.view_mode
  FROM public.message_attachments attachment
  JOIN public.messages message ON message.id = attachment.message_id
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
  WHERE attachment.id = ANY (_attachment_ids)
    AND (
      conversation.client_id = _user_id
      OR EXISTS (
        SELECT 1 FROM public.character_operator_assignments assignment
        JOIN public.operators operator ON operator.id = assignment.operator_id
        WHERE assignment.character_id = conversation.character_id AND operator.user_id = _user_id AND operator.is_active = TRUE
      )
      OR EXISTS (SELECT 1 FROM public.user_roles role WHERE role.user_id = _user_id AND role.role = 'admin')
    );
END;
$$;

CREATE FUNCTION public.open_free_view_once_attachment(
  _attachment_id UUID,
  _idempotency_key UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _attachment public.message_attachments%ROWTYPE;
  _client_id UUID;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT attachment.*
  INTO _attachment
  FROM public.message_attachments attachment
  WHERE attachment.id = _attachment_id
  FOR UPDATE OF attachment;
  IF NOT FOUND THEN RAISE EXCEPTION 'message_attachment_not_available'; END IF;
  SELECT conversation.client_id INTO _client_id
  FROM public.messages message
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
  WHERE message.id = _attachment.message_id;
  IF _client_id <> _user_id THEN RAISE EXCEPTION 'message_attachment_not_available'; END IF;
  IF _attachment.view_mode <> 'view_once' THEN RAISE EXCEPTION 'attachment_not_view_once'; END IF;
  IF _attachment.view_once_opened_at IS NOT NULL THEN RAISE EXCEPTION 'view_once_already_opened'; END IF;
  UPDATE public.message_attachments
  SET view_once_opened_at = clock_timestamp()
  WHERE id = _attachment.id
  RETURNING view_once_opened_at INTO _attachment.view_once_opened_at;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_user_id, 'message_attachment.view_once_opened', 'message_attachment', _attachment.id::TEXT,
    jsonb_build_object('idempotency_key_present', _idempotency_key IS NOT NULL));
  RETURN jsonb_build_object('attachment_id', _attachment.id, 'render_state', 'view_once_opened');
END;
$$;

CREATE FUNCTION public.complete_free_view_once_attachment(_attachment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _attachment public.message_attachments%ROWTYPE;
  _client_id UUID;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT attachment.*
  INTO _attachment
  FROM public.message_attachments attachment
  WHERE attachment.id = _attachment_id
  FOR UPDATE OF attachment;
  IF NOT FOUND THEN RAISE EXCEPTION 'message_attachment_not_available'; END IF;
  SELECT conversation.client_id INTO _client_id
  FROM public.messages message
  JOIN public.conversations conversation ON conversation.id = message.conversation_id
  WHERE message.id = _attachment.message_id;
  IF _client_id <> _user_id THEN RAISE EXCEPTION 'message_attachment_not_available'; END IF;
  IF _attachment.view_mode <> 'view_once' THEN RAISE EXCEPTION 'attachment_not_view_once'; END IF;
  IF _attachment.view_once_opened_at IS NULL OR _attachment.view_once_completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('attachment_id', _attachment.id, 'completed', _attachment.view_once_completed_at IS NOT NULL);
  END IF;
  UPDATE public.message_attachments SET view_once_completed_at = clock_timestamp() WHERE id = _attachment.id;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_user_id, 'message_attachment.view_once_completed', 'message_attachment', _attachment.id::TEXT, '{}'::JSONB);
  RETURN jsonb_build_object('attachment_id', _attachment.id, 'completed', true);
END;
$$;

CREATE FUNCTION public.get_message_attachment_view_url_ttl_for_server(
  _actor_user_id UUID,
  _attachment_id UUID
)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN conversation.client_id = _actor_user_id AND attachment.view_mode = 'view_once'
      AND attachment.view_once_opened_at IS NOT NULL
      AND attachment.view_once_completed_at IS NULL
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
SET search_path = public, pg_temp
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
      AND ((attachment.view_mode = 'view_once' AND attachment.access_mode = 'standard' AND asset.preview_generated_at IS NOT NULL)
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
      AND (EXISTS (SELECT 1 FROM public.user_roles role WHERE role.user_id = _actor_user_id AND role.role = 'admin')
        OR EXISTS (SELECT 1 FROM public.operators operator JOIN public.character_operator_assignments assignment ON assignment.operator_id = operator.id AND assignment.character_id = conversation.character_id WHERE operator.id = reservation.operator_id AND operator.user_id = _actor_user_id AND operator.is_active = TRUE AND reservation.reserved_by_user_id = _actor_user_id))
      AND (_concurrency_mode <> 'lock' OR NOT EXISTS (SELECT 1 FROM public.conversation_locks conversation_lock WHERE conversation_lock.conversation_id = conversation.id AND conversation_lock.released_at IS NULL AND conversation_lock.expires_at > clock_timestamp() AND conversation_lock.locked_by_operator_id <> reservation.operator_id));
    RETURN _path;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.send_operator_media_message(UUID, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_admin_media_message(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_message_attachment_access(UUID[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.open_free_view_once_attachment(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_free_view_once_attachment(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_message_attachment_view_url_ttl_for_server(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_character_media_preview_path_for_server(UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.send_operator_media_message(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_admin_media_message(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_message_attachment_access(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_free_view_once_attachment(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_free_view_once_attachment(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_message_attachment_view_url_ttl_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_character_media_preview_path_for_server(UUID, TEXT, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';

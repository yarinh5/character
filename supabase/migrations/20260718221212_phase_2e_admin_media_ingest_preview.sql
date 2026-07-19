-- Phase 2E-A: server-mediated Admin media ingest and generated previews.

ALTER TABLE public.character_media_assets
  ADD COLUMN processing_started_at TIMESTAMPTZ,
  ADD COLUMN processing_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (processing_attempts >= 0),
  ADD COLUMN preview_generated_at TIMESTAMPTZ,
  ADD COLUMN processing_error_code TEXT,
  ADD COLUMN status_before_disabled TEXT
    CHECK (status_before_disabled IN ('available', 'restored', 'sent'));

-- Preserve valid legacy previews, but never leave a ready asset without one.
UPDATE public.character_media_assets asset
SET preview_generated_at = COALESCE(asset.updated_at, asset.created_at)
WHERE asset.ingest_status = 'ready'
  AND asset.preview_path IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM storage.objects object
    WHERE object.bucket_id = asset.bucket_id
      AND object.name = asset.preview_path
  );

UPDATE public.character_media_assets asset
SET
  ingest_status = 'failed',
  processing_error_code = 'preview_missing'
WHERE asset.ingest_status = 'ready'
  AND asset.preview_generated_at IS NULL;

ALTER TABLE public.character_media_assets
  ADD CONSTRAINT character_media_assets_ready_preview_check
  CHECK (
    ingest_status <> 'ready'
    OR (preview_path IS NOT NULL AND preview_generated_at IS NOT NULL)
  ),
  ADD CONSTRAINT character_media_assets_disabled_previous_status_check
  CHECK (
    (status = 'disabled' AND status_before_disabled IS NOT NULL)
    OR (status <> 'disabled' AND status_before_disabled IS NULL)
  );

CREATE INDEX character_media_assets_processing_idx
  ON public.character_media_assets (ingest_status, processing_started_at)
  WHERE ingest_status IN ('pending', 'failed');

DROP POLICY IF EXISTS "Admins view character media assets" ON public.character_media_assets;
DROP POLICY IF EXISTS "Admins view character media reservations" ON public.character_media_reservations;
DROP POLICY IF EXISTS "Admins manage character media objects" ON storage.objects;

DROP FUNCTION IF EXISTS public.create_character_media_upload_intent(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.complete_character_media_upload(UUID);

CREATE FUNCTION public.create_character_media_upload_intent_for_server(
  _actor_user_id UUID,
  _character_id UUID,
  _content_type TEXT,
  _display_name TEXT DEFAULT NULL
)
RETURNS TABLE (
  asset_id UUID,
  source_path TEXT,
  content_type TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _asset public.character_media_assets%ROWTYPE;
  _extension TEXT;
BEGIN
  IF auth.role() <> 'service_role' OR _actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.user_roles role
    WHERE role.user_id = _actor_user_id
      AND role.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF _content_type NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RAISE EXCEPTION 'unsupported_media_content_type';
  END IF;

  PERFORM 1 FROM public.characters character WHERE character.id = _character_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'character_not_found';
  END IF;

  _extension := CASE _content_type
    WHEN 'image/jpeg' THEN 'jpg'
    WHEN 'image/png' THEN 'png'
    WHEN 'image/webp' THEN 'webp'
  END;

  INSERT INTO public.character_media_assets (
    character_id,
    source_path,
    preview_path,
    content_type,
    display_name,
    created_by_user_id,
    updated_by_user_id
  )
  VALUES (
    _character_id,
    format('characters/%s/%s/source.%s', _character_id, gen_random_uuid(), _extension),
    NULL,
    _content_type,
    NULLIF(btrim(_display_name), ''),
    _actor_user_id,
    _actor_user_id
  )
  RETURNING * INTO _asset;

  UPDATE public.character_media_assets
  SET
    source_path = format('characters/%s/%s/source.%s', _character_id, _asset.id, _extension),
    preview_path = format('characters/%s/%s/preview.webp', _character_id, _asset.id),
    updated_by_user_id = _actor_user_id
  WHERE id = _asset.id
  RETURNING * INTO _asset;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _actor_user_id,
    'character_media_asset.upload_intent_created',
    'character_media_asset',
    _asset.id::TEXT,
    jsonb_build_object('character_id', _character_id, 'content_type', _content_type)
  );

  RETURN QUERY SELECT _asset.id, _asset.source_path, _asset.content_type;
END;
$$;

CREATE FUNCTION public.begin_character_media_processing_for_server(
  _actor_user_id UUID,
  _asset_id UUID
)
RETURNS TABLE (
  asset_id UUID,
  source_path TEXT,
  preview_path TEXT,
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
    SELECT 1
    FROM public.user_roles role
    WHERE role.user_id = _actor_user_id
      AND role.role = 'admin'
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

  IF _asset.ingest_status = 'ready' AND _asset.preview_generated_at IS NOT NULL THEN
    RETURN QUERY SELECT _asset.id, NULL::TEXT, NULL::TEXT, _asset.content_type, TRUE;
    RETURN;
  END IF;

  IF _asset.status NOT IN ('available', 'restored') THEN
    RAISE EXCEPTION 'media_asset_not_processable';
  END IF;

  IF _asset.ingest_status = 'pending'
    AND _asset.processing_started_at IS NOT NULL
    AND _asset.processing_started_at > clock_timestamp() - INTERVAL '10 minutes' THEN
    RAISE EXCEPTION 'media_processing_in_progress';
  END IF;

  UPDATE public.character_media_assets
  SET
    ingest_status = 'pending',
    processing_started_at = clock_timestamp(),
    processing_attempts = processing_attempts + 1,
    processing_error_code = NULL,
    preview_generated_at = NULL,
    updated_by_user_id = _actor_user_id
  WHERE id = _asset.id
  RETURNING * INTO _asset;

  RETURN QUERY SELECT _asset.id, _asset.source_path, _asset.preview_path, _asset.content_type, FALSE;
END;
$$;

CREATE FUNCTION public.finalize_character_media_ingest_for_server(
  _actor_user_id UUID,
  _asset_id UUID,
  _byte_size BIGINT,
  _width INTEGER,
  _height INTEGER,
  _sha256 TEXT
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
    SELECT 1
    FROM public.user_roles role
    WHERE role.user_id = _actor_user_id
      AND role.role = 'admin'
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

  IF _asset.ingest_status = 'ready' AND _asset.preview_generated_at IS NOT NULL THEN
    RETURN jsonb_build_object('asset_id', _asset.id, 'ingest_status', 'ready', 'already_ready', TRUE);
  END IF;

  IF _asset.status NOT IN ('available', 'restored')
    OR _asset.ingest_status <> 'pending'
    OR _byte_size <= 0
    OR _width <= 0
    OR _height <= 0
    OR _sha256 !~ '^[0-9a-f]{64}$'
    OR NOT EXISTS (
      SELECT 1
      FROM storage.objects object
      WHERE object.bucket_id = _asset.bucket_id
        AND object.name = _asset.preview_path
    ) THEN
    RAISE EXCEPTION 'media_ingest_finalize_invalid';
  END IF;

  UPDATE public.character_media_assets
  SET
    ingest_status = 'ready',
    byte_size = _byte_size,
    width = _width,
    height = _height,
    sha256 = _sha256,
    preview_generated_at = clock_timestamp(),
    processing_started_at = NULL,
    processing_error_code = NULL,
    updated_by_user_id = _actor_user_id
  WHERE id = _asset.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _actor_user_id,
    'character_media_asset.ingest_ready',
    'character_media_asset',
    _asset.id::TEXT,
    jsonb_build_object('byte_size', _byte_size, 'width', _width, 'height', _height)
  );

  RETURN jsonb_build_object('asset_id', _asset.id, 'ingest_status', 'ready', 'already_ready', FALSE);
END;
$$;

CREATE FUNCTION public.fail_character_media_ingest_for_server(
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
  _safe_error_code TEXT := lower(btrim(COALESCE(_error_code, 'processing_failed')));
BEGIN
  IF auth.role() <> 'service_role' OR _actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.user_roles role
    WHERE role.user_id = _actor_user_id
      AND role.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF _safe_error_code !~ '^[a-z0-9_]{1,64}$' THEN
    _safe_error_code := 'processing_failed';
  END IF;

  SELECT * INTO _asset
  FROM public.character_media_assets asset
  WHERE asset.id = _asset_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_asset_not_found';
  END IF;

  IF _asset.ingest_status = 'ready' AND _asset.preview_generated_at IS NOT NULL THEN
    RETURN jsonb_build_object('asset_id', _asset.id, 'ingest_status', 'ready', 'already_ready', TRUE);
  END IF;

  UPDATE public.character_media_assets
  SET
    ingest_status = 'failed',
    processing_started_at = NULL,
    processing_error_code = _safe_error_code,
    preview_generated_at = NULL,
    updated_by_user_id = _actor_user_id
  WHERE id = _asset.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _actor_user_id,
    'character_media_asset.ingest_failed',
    'character_media_asset',
    _asset.id::TEXT,
    jsonb_build_object('error_code', _safe_error_code)
  );

  RETURN jsonb_build_object('asset_id', _asset.id, 'ingest_status', 'failed', 'error_code', _safe_error_code);
END;
$$;

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
    (asset.ingest_status = 'ready' AND asset.preview_generated_at IS NOT NULL) AS preview_available,
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

CREATE FUNCTION public.disable_character_media_asset(
  _asset_id UUID,
  _reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _asset public.character_media_assets%ROWTYPE;
  _reason_clean TEXT := NULLIF(left(btrim(COALESCE(_reason, '')), 500), '');
BEGIN
  IF _user_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  PERFORM private.expire_character_media_reservations(NULL, _asset_id);

  SELECT * INTO _asset
  FROM public.character_media_assets asset
  WHERE asset.id = _asset_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_asset_not_found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.character_media_reservations reservation
    WHERE reservation.media_asset_id = _asset.id
      AND reservation.state = 'active'
  ) THEN
    RAISE EXCEPTION 'media_asset_has_active_reservation';
  END IF;

  IF _asset.status = 'disabled' THEN
    RETURN jsonb_build_object('asset_id', _asset.id, 'status', 'disabled', 'already_disabled', TRUE);
  END IF;

  IF _asset.status NOT IN ('available', 'restored', 'sent') THEN
    RAISE EXCEPTION 'media_asset_not_disableable';
  END IF;

  UPDATE public.character_media_assets
  SET
    status_before_disabled = _asset.status,
    status = 'disabled',
    disabled_at = clock_timestamp(),
    disabled_by_user_id = _user_id,
    disabled_reason = _reason_clean,
    updated_by_user_id = _user_id
  WHERE id = _asset.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_user_id, 'character_media_asset.disabled', 'character_media_asset', _asset.id::TEXT, jsonb_build_object('reason', _reason_clean));

  RETURN jsonb_build_object('asset_id', _asset.id, 'status', 'disabled', 'already_disabled', FALSE);
END;
$$;

CREATE FUNCTION public.restore_character_media_asset(
  _asset_id UUID
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

  IF _asset.status <> 'disabled' OR _asset.status_before_disabled IS NULL THEN
    RAISE EXCEPTION 'media_asset_not_disabled';
  END IF;

  UPDATE public.character_media_assets
  SET
    status = _asset.status_before_disabled,
    status_before_disabled = NULL,
    disabled_at = NULL,
    disabled_by_user_id = NULL,
    disabled_reason = NULL,
    updated_by_user_id = _user_id
  WHERE id = _asset.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_user_id, 'character_media_asset.restored', 'character_media_asset', _asset.id::TEXT, jsonb_build_object('status', _asset.status_before_disabled));

  RETURN jsonb_build_object('asset_id', _asset.id, 'status', _asset.status_before_disabled);
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
  _preview_path TEXT;
  _concurrency_mode TEXT;
BEGIN
  IF _actor_user_id IS NULL OR _target_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF _target_kind = 'admin_asset_preview' THEN
    SELECT asset.preview_path
    INTO _preview_path
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

    RETURN _preview_path;
  END IF;

  IF _target_kind = 'message_attachment' THEN
    SELECT asset.preview_path
    INTO _preview_path
    FROM public.message_attachments attachment
    JOIN public.messages message ON message.id = attachment.message_id
    JOIN public.conversations conversation ON conversation.id = message.conversation_id
    JOIN public.character_media_assets asset ON asset.id = attachment.media_asset_id
    WHERE attachment.id = _target_id
      AND asset.bucket_id = 'character-media'
      AND asset.ingest_status = 'ready'
      AND asset.preview_generated_at IS NOT NULL
      AND asset.preview_path IS NOT NULL
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

    RETURN _preview_path;
  END IF;

  IF _target_kind = 'reserved_preview' THEN
    SELECT setting.value INTO _concurrency_mode
    FROM public.system_settings setting
    WHERE setting.key = 'concurrency_mode';

    SELECT asset.preview_path
    INTO _preview_path
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

    RETURN _preview_path;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.create_character_media_upload_intent_for_server(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_character_media_processing_for_server(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_character_media_ingest_for_server(UUID, UUID, BIGINT, INTEGER, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_character_media_ingest_for_server(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_admin_character_media_assets(UUID)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.disable_character_media_asset(UUID, TEXT)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.restore_character_media_asset(UUID)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_character_media_preview_path_for_server(UUID, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_character_media_upload_intent_for_server(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_character_media_processing_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_character_media_ingest_for_server(UUID, UUID, BIGINT, INTEGER, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_character_media_ingest_for_server(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_character_media_assets(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.disable_character_media_asset(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restore_character_media_asset(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_character_media_preview_path_for_server(UUID, TEXT, UUID) TO service_role;

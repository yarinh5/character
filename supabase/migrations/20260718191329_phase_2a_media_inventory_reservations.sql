-- Phase 2A: private character-media inventory and reservations.
-- No message attachments or media delivery are introduced here.

CREATE TABLE public.character_media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id UUID NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  bucket_id TEXT NOT NULL DEFAULT 'character-media'
    CHECK (bucket_id = 'character-media'),
  source_path TEXT NOT NULL UNIQUE,
  preview_path TEXT,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'reserved', 'sent', 'restored', 'disabled')),
  ingest_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (ingest_status IN ('pending', 'ready', 'failed')),
  display_name TEXT,
  content_type TEXT NOT NULL
    CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size BIGINT CHECK (byte_size IS NULL OR byte_size > 0),
  width INTEGER CHECK (width IS NULL OR width > 0),
  height INTEGER CHECK (height IS NULL OR height > 0),
  sha256 TEXT,
  disabled_at TIMESTAMPTZ,
  disabled_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  disabled_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (
    (status = 'disabled' AND disabled_at IS NOT NULL)
    OR (
      status <> 'disabled'
      AND disabled_at IS NULL
      AND disabled_by_user_id IS NULL
      AND disabled_reason IS NULL
    )
  )
);

CREATE INDEX character_media_assets_catalog_idx
  ON public.character_media_assets (character_id, status, created_at DESC);

CREATE INDEX character_media_assets_ready_idx
  ON public.character_media_assets (character_id, created_at DESC)
  WHERE status IN ('available', 'restored') AND ingest_status = 'ready';

CREATE TABLE public.character_media_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id UUID NOT NULL REFERENCES public.character_media_assets(id) ON DELETE RESTRICT,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE RESTRICT,
  reserved_by_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  previous_asset_status TEXT NOT NULL
    CHECK (previous_asset_status IN ('available', 'restored')),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'released', 'consumed', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  ended_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ended_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (expires_at > created_at),
  CHECK (
    (state = 'active' AND ended_at IS NULL)
    OR (state <> 'active' AND ended_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX character_media_reservations_one_active_asset_idx
  ON public.character_media_reservations (media_asset_id)
  WHERE state = 'active';

CREATE INDEX character_media_reservations_expiry_idx
  ON public.character_media_reservations (expires_at)
  WHERE state = 'active';

CREATE INDEX character_media_reservations_conversation_idx
  ON public.character_media_reservations (conversation_id, state, created_at DESC);

ALTER TABLE public.character_media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.character_media_reservations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.character_media_assets FROM anon, authenticated;
REVOKE ALL ON public.character_media_reservations FROM anon, authenticated;

CREATE POLICY "Admins view character media assets"
  ON public.character_media_assets
  FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY "Admins view character media reservations"
  ON public.character_media_reservations
  FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE OR REPLACE FUNCTION private.touch_character_media_asset_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_character_media_assets_updated_at
  BEFORE UPDATE ON public.character_media_assets
  FOR EACH ROW
  EXECUTE FUNCTION private.touch_character_media_asset_updated_at();

CREATE OR REPLACE FUNCTION private.expire_character_media_reservations(
  _character_id UUID DEFAULT NULL,
  _asset_id UUID DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _reservation RECORD;
  _expired_count INTEGER := 0;
BEGIN
  FOR _reservation IN
    SELECT
      r.id,
      r.media_asset_id,
      r.previous_asset_status
    FROM public.character_media_reservations r
    JOIN public.character_media_assets a ON a.id = r.media_asset_id
    WHERE r.state = 'active'
      AND r.expires_at <= clock_timestamp()
      AND (_character_id IS NULL OR a.character_id = _character_id)
      AND (_asset_id IS NULL OR r.media_asset_id = _asset_id)
    FOR UPDATE OF r, a SKIP LOCKED
  LOOP
    UPDATE public.character_media_reservations
    SET
      state = 'expired',
      ended_at = clock_timestamp(),
      ended_reason = 'expired'
    WHERE id = _reservation.id
      AND state = 'active';

    UPDATE public.character_media_assets
    SET
      status = _reservation.previous_asset_status,
      updated_by_user_id = NULL
    WHERE id = _reservation.media_asset_id
      AND status = 'reserved';

    INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (
      NULL,
      'character_media_reservation.expired',
      'character_media_reservation',
      _reservation.id::TEXT,
      jsonb_build_object('media_asset_id', _reservation.media_asset_id)
    );

    _expired_count := _expired_count + 1;
  END LOOP;

  RETURN _expired_count;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_operator_can_manage_conversation_media(
  _conversation_id UUID
)
RETURNS TABLE (
  operator_id UUID,
  user_id UUID,
  character_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _operator_id UUID;
  _conversation public.conversations%ROWTYPE;
  _active_lock public.conversation_locks%ROWTYPE;
  _concurrency_mode TEXT := COALESCE(private.setting_text('concurrency_mode', 'open'), 'open');
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT o.id
  INTO _operator_id
  FROM public.operators o
  WHERE o.user_id = _user_id
    AND o.is_active = true
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations c
  WHERE c.id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF _conversation.status <> 'open'::public.conversation_status THEN
    RAISE EXCEPTION 'conversation_closed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.character_operator_assignments coa
    WHERE coa.character_id = _conversation.character_id
      AND coa.operator_id = _operator_id
  ) THEN
    RAISE EXCEPTION 'operator_not_assigned_to_character';
  END IF;

  IF _concurrency_mode = 'lock' THEN
    SELECT *
    INTO _active_lock
    FROM public.conversation_locks l
    WHERE l.conversation_id = _conversation_id
      AND l.released_at IS NULL
      AND l.expires_at > clock_timestamp()
    FOR UPDATE;

    IF FOUND AND _active_lock.locked_by_operator_id <> _operator_id THEN
      RAISE EXCEPTION 'conversation_locked_by_other_operator';
    END IF;
  END IF;

  RETURN QUERY SELECT _operator_id, _user_id, _conversation.character_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_operator_media_catalog(
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
  reservation_id UUID,
  reservation_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _guard RECORD;
BEGIN
  SELECT * INTO _guard
  FROM private.assert_operator_can_manage_conversation_media(_conversation_id);

  PERFORM private.expire_character_media_reservations(_guard.character_id, NULL);

  RETURN QUERY
  SELECT
    a.id,
    a.display_name,
    a.status,
    a.ingest_status,
    a.content_type,
    a.byte_size,
    a.width,
    a.height,
    (a.status IN ('available', 'restored') AND a.ingest_status = 'ready') AS is_reservable,
    r.id,
    r.expires_at
  FROM public.character_media_assets a
  LEFT JOIN public.character_media_reservations r
    ON r.media_asset_id = a.id
    AND r.state = 'active'
  WHERE a.character_id = _guard.character_id
  ORDER BY a.created_at DESC, a.id DESC;
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
DECLARE
  _guard RECORD;
  _asset public.character_media_assets%ROWTYPE;
  _reservation public.character_media_reservations%ROWTYPE;
  _expires_at TIMESTAMPTZ := clock_timestamp() + INTERVAL '5 minutes';
BEGIN
  SELECT * INTO _guard
  FROM private.assert_operator_can_manage_conversation_media(_conversation_id);

  PERFORM private.expire_character_media_reservations(NULL, _asset_id);

  SELECT *
  INTO _asset
  FROM public.character_media_assets a
  WHERE a.id = _asset_id
    AND a.character_id = _guard.character_id
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

  INSERT INTO public.character_media_reservations (
    media_asset_id,
    conversation_id,
    operator_id,
    reserved_by_user_id,
    previous_asset_status,
    expires_at
  )
  VALUES (
    _asset.id,
    _conversation_id,
    _guard.operator_id,
    _guard.user_id,
    _asset.status,
    _expires_at
  )
  RETURNING * INTO _reservation;

  UPDATE public.character_media_assets
  SET
    status = 'reserved',
    updated_by_user_id = _guard.user_id
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
      'expires_at', _expires_at
    )
  );

  RETURN jsonb_build_object(
    'reservation_id', _reservation.id,
    'asset_id', _asset.id,
    'expires_at', _expires_at,
    'status', 'reserved'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_character_media_reservation(
  _reservation_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _reservation public.character_media_reservations%ROWTYPE;
  _asset public.character_media_assets%ROWTYPE;
  _guard RECORD;
  _is_admin BOOLEAN := public.is_admin();
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT *
  INTO _reservation
  FROM public.character_media_reservations r
  WHERE r.id = _reservation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_reservation_not_found';
  END IF;

  PERFORM private.expire_character_media_reservations(NULL, _reservation.media_asset_id);

  SELECT *
  INTO _reservation
  FROM public.character_media_reservations r
  WHERE r.id = _reservation_id
  FOR UPDATE;

  IF _reservation.state <> 'active' THEN
    RETURN jsonb_build_object('reservation_id', _reservation.id, 'state', _reservation.state);
  END IF;

  IF NOT _is_admin THEN
    SELECT * INTO _guard
    FROM private.assert_operator_can_manage_conversation_media(_reservation.conversation_id);

    IF _guard.operator_id <> _reservation.operator_id THEN
      RAISE EXCEPTION 'media_reservation_not_owned';
    END IF;
  END IF;

  SELECT *
  INTO _asset
  FROM public.character_media_assets a
  WHERE a.id = _reservation.media_asset_id
  FOR UPDATE;

  UPDATE public.character_media_reservations
  SET
    state = 'released',
    ended_at = clock_timestamp(),
    ended_by_user_id = _user_id,
    ended_reason = 'released'
  WHERE id = _reservation.id;

  UPDATE public.character_media_assets
  SET
    status = _reservation.previous_asset_status,
    updated_by_user_id = _user_id
  WHERE id = _asset.id
    AND status = 'reserved';

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _user_id,
    'character_media_reservation.released',
    'character_media_reservation',
    _reservation.id::TEXT,
    jsonb_build_object('media_asset_id', _asset.id)
  );

  RETURN jsonb_build_object(
    'reservation_id', _reservation.id,
    'asset_id', _asset.id,
    'status', _reservation.previous_asset_status,
    'state', 'released'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_character_media_upload_intent(
  _character_id UUID,
  _content_type TEXT,
  _display_name TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _asset public.character_media_assets%ROWTYPE;
  _extension TEXT;
BEGIN
  IF _user_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF _content_type NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RAISE EXCEPTION 'unsupported_media_content_type';
  END IF;

  PERFORM 1 FROM public.characters WHERE id = _character_id;
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
    _user_id,
    _user_id
  )
  RETURNING * INTO _asset;

  -- Rewrite the path with the persisted asset id, never with a client-supplied filename.
  UPDATE public.character_media_assets
  SET
    source_path = format('characters/%s/%s/source.%s', _character_id, _asset.id, _extension),
    preview_path = format('characters/%s/%s/preview.webp', _character_id, _asset.id),
    updated_by_user_id = _user_id
  WHERE id = _asset.id
  RETURNING * INTO _asset;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _user_id,
    'character_media_asset.upload_intent_created',
    'character_media_asset',
    _asset.id::TEXT,
    jsonb_build_object('character_id', _character_id, 'content_type', _content_type)
  );

  RETURN jsonb_build_object(
    'asset_id', _asset.id,
    'source_path', _asset.source_path,
    'preview_path', _asset.preview_path,
    'ingest_status', _asset.ingest_status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_character_media_upload(
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
  _object_metadata JSONB;
  _object_mime TEXT;
  _object_size BIGINT;
BEGIN
  IF _user_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  SELECT *
  INTO _asset
  FROM public.character_media_assets a
  WHERE a.id = _asset_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_asset_not_found';
  END IF;

  SELECT o.metadata
  INTO _object_metadata
  FROM storage.objects o
  WHERE o.bucket_id = _asset.bucket_id
    AND o.name = _asset.source_path;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_source_object_not_found';
  END IF;

  _object_mime := _object_metadata ->> 'mimetype';
  _object_size := CASE
    WHEN COALESCE(_object_metadata ->> 'size', '') ~ '^[0-9]+$'
      THEN (_object_metadata ->> 'size')::BIGINT
    ELSE NULL
  END;

  IF _object_mime IS DISTINCT FROM _asset.content_type OR COALESCE(_object_size, 0) <= 0 THEN
    RAISE EXCEPTION 'media_source_metadata_invalid';
  END IF;

  UPDATE public.character_media_assets
  SET
    ingest_status = 'ready',
    byte_size = _object_size,
    updated_by_user_id = _user_id
  WHERE id = _asset.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _user_id,
    'character_media_asset.ingest_ready',
    'character_media_asset',
    _asset.id::TEXT,
    jsonb_build_object('byte_size', _object_size, 'content_type', _object_mime)
  );

  RETURN jsonb_build_object('asset_id', _asset.id, 'ingest_status', 'ready');
END;
$$;

REVOKE ALL ON FUNCTION private.expire_character_media_reservations(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.assert_operator_can_manage_conversation_media(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_operator_media_catalog(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_character_media_asset(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_character_media_reservation(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_character_media_upload_intent(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_character_media_upload(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_operator_media_catalog(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_character_media_asset(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_character_media_reservation(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_character_media_upload_intent(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_character_media_upload(UUID) TO authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'character-media',
  'character-media',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp']::TEXT[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE POLICY "Admins manage character media objects"
  ON storage.objects
  FOR ALL TO authenticated
  USING (
    bucket_id = 'character-media'
    AND public.is_admin()
    AND (storage.foldername(name))[1] = 'characters'
  )
  WITH CHECK (
    bucket_id = 'character-media'
    AND public.is_admin()
    AND (storage.foldername(name))[1] = 'characters'
  );

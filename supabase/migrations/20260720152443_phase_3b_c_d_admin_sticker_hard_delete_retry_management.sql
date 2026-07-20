-- Admin-only recovery and destructive cleanup. A deletion marker blocks sends
-- while the trusted Edge Function removes private Storage objects.
ALTER TABLE public.stickers
  ADD COLUMN deletion_started_at TIMESTAMPTZ;

CREATE INDEX stickers_deletion_started_at_idx
  ON public.stickers (deletion_started_at)
  WHERE deletion_started_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.begin_sticker_processing_for_server(
  _actor_user_id UUID,
  _sticker_id UUID
)
RETURNS TABLE (sticker_id UUID, source_path TEXT, object_path TEXT, already_ready BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _sticker public.stickers%ROWTYPE;
BEGIN
  PERFORM private.assert_sticker_server_admin(_actor_user_id);

  SELECT * INTO _sticker
  FROM public.stickers s
  WHERE s.id = _sticker_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'sticker_not_found'; END IF;
  IF _sticker.deletion_started_at IS NOT NULL THEN RAISE EXCEPTION 'sticker_deletion_in_progress'; END IF;

  IF _sticker.ingest_status = 'ready' THEN
    RETURN QUERY SELECT _sticker.id, NULL::TEXT, _sticker.object_path, true;
    RETURN;
  END IF;

  IF _sticker.ingest_status = 'processing'
    AND (
      _sticker.processing_started_at IS NULL
      OR _sticker.processing_started_at > clock_timestamp() - INTERVAL '10 minutes'
    ) THEN
    RAISE EXCEPTION 'sticker_processing_in_progress';
  END IF;

  IF _sticker.source_path IS NULL THEN RAISE EXCEPTION 'sticker_upload_required'; END IF;

  UPDATE public.stickers s
  SET
    ingest_status = 'processing',
    processing_started_at = clock_timestamp(),
    failed_at = NULL,
    failure_code = NULL,
    updated_at = clock_timestamp(),
    updated_by_user_id = _actor_user_id
  WHERE s.id = _sticker.id;

  RETURN QUERY SELECT _sticker.id, _sticker.source_path, _sticker.object_path, false;
END;
$$;

DROP FUNCTION IF EXISTS public.get_admin_sticker_catalog();

CREATE FUNCTION public.get_admin_sticker_catalog()
RETURNS TABLE (
  id UUID, collection_id UUID, collection_name TEXT, collection_slug TEXT, character_id UUID,
  name TEXT, slug TEXT, is_active BOOLEAN, collection_is_active BOOLEAN, ingest_status TEXT,
  width INTEGER, height INTEGER, byte_size INTEGER, failure_code TEXT,
  processing_started_at TIMESTAMPTZ, is_processing_stuck BOOLEAN, deletion_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_required'; END IF;

  RETURN QUERY
  SELECT
    s.id, sc.id, sc.name, sc.slug, sc.character_id,
    s.name, s.slug, s.is_active, sc.is_active, s.ingest_status,
    s.width, s.height, s.byte_size, s.failure_code,
    s.processing_started_at,
    (
      s.ingest_status = 'processing'
      AND s.processing_started_at IS NOT NULL
      AND s.processing_started_at <= clock_timestamp() - INTERVAL '10 minutes'
    ),
    s.deletion_started_at,
    s.created_at, s.updated_at
  FROM public.stickers s
  JOIN public.sticker_collections sc ON sc.id = s.collection_id
  ORDER BY sc.sort_order, sc.name, s.sort_order, s.name, s.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_sticker_active(_sticker_id UUID, _is_active BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_required'; END IF;

  UPDATE public.stickers s
  SET
    is_active = _is_active,
    updated_at = clock_timestamp(),
    updated_by_user_id = auth.uid()
  WHERE s.id = _sticker_id
    AND s.deletion_started_at IS NULL
    AND (NOT _is_active OR s.ingest_status = 'ready');

  IF FOUND THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.stickers s WHERE s.id = _sticker_id AND s.deletion_started_at IS NOT NULL) THEN
    RAISE EXCEPTION 'sticker_deletion_in_progress';
  END IF;
  RAISE EXCEPTION 'sticker_not_ready';
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_message_sticker_marker()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _message public.messages%ROWTYPE;
  _sticker RECORD;
BEGIN
  SELECT * INTO _message FROM public.messages WHERE id = NEW.message_id;
  IF NOT FOUND
    OR _message.content <> '[sticker]'
    OR _message.sender_type NOT IN ('client'::public.sender_type, 'operator'::public.sender_type) THEN
    RAISE EXCEPTION 'invalid_sticker_message_marker';
  END IF;

  SELECT s.id, s.is_active, s.ingest_status, s.deletion_started_at, sc.is_active AS collection_is_active
  INTO _sticker
  FROM public.stickers s
  JOIN public.sticker_collections sc ON sc.id = s.collection_id
  WHERE s.id = NEW.sticker_id
  FOR KEY SHARE OF s;

  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_sticker_message_marker'; END IF;
  IF _sticker.deletion_started_at IS NOT NULL THEN RAISE EXCEPTION 'sticker_not_available'; END IF;
  IF _sticker.is_active IS NOT TRUE OR _sticker.ingest_status <> 'ready' OR _sticker.collection_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid_sticker_message_marker';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.begin_sticker_hard_delete_for_server(
  _actor_user_id UUID,
  _sticker_id UUID
)
RETURNS TABLE (sticker_id UUID, source_paths TEXT[], object_path TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _sticker public.stickers%ROWTYPE;
BEGIN
  PERFORM private.assert_sticker_server_admin(_actor_user_id);

  SELECT * INTO _sticker
  FROM public.stickers s
  WHERE s.id = _sticker_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'sticker_not_found'; END IF;
  IF EXISTS (SELECT 1 FROM public.message_stickers ms WHERE ms.sticker_id = _sticker.id)
    OR EXISTS (SELECT 1 FROM private.sticker_send_attempts a WHERE a.sticker_id = _sticker.id) THEN
    RAISE EXCEPTION 'sticker_in_use';
  END IF;

  UPDATE public.stickers s
  SET
    is_active = false,
    deletion_started_at = coalesce(s.deletion_started_at, clock_timestamp()),
    updated_at = clock_timestamp(),
    updated_by_user_id = _actor_user_id
  WHERE s.id = _sticker.id;

  RETURN QUERY
  SELECT
    _sticker.id,
    ARRAY[
      _sticker.source_path,
      format('collections/%s/stickers/%s/source.webp', _sticker.collection_id, _sticker.id),
      format('collections/%s/stickers/%s/source.png', _sticker.collection_id, _sticker.id),
      format('collections/%s/stickers/%s/source.jpg', _sticker.collection_id, _sticker.id),
      format('collections/%s/stickers/%s/source.jpeg', _sticker.collection_id, _sticker.id)
    ]::TEXT[],
    _sticker.object_path;
END;
$$;

CREATE FUNCTION public.complete_sticker_hard_delete_for_server(
  _actor_user_id UUID,
  _sticker_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _sticker public.stickers%ROWTYPE;
BEGIN
  PERFORM private.assert_sticker_server_admin(_actor_user_id);

  SELECT * INTO _sticker
  FROM public.stickers s
  WHERE s.id = _sticker_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'sticker_not_found'; END IF;
  IF _sticker.deletion_started_at IS NULL THEN RAISE EXCEPTION 'sticker_delete_not_started'; END IF;
  IF EXISTS (SELECT 1 FROM public.message_stickers ms WHERE ms.sticker_id = _sticker.id)
    OR EXISTS (SELECT 1 FROM private.sticker_send_attempts a WHERE a.sticker_id = _sticker.id) THEN
    RAISE EXCEPTION 'sticker_in_use';
  END IF;

  BEGIN
    DELETE FROM public.stickers s WHERE s.id = _sticker.id;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'sticker_in_use';
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_sticker_processing_for_server(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_sticker_hard_delete_for_server(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_sticker_hard_delete_for_server(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_admin_sticker_catalog() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_sticker_active(UUID, BOOLEAN) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.begin_sticker_processing_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_sticker_hard_delete_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_sticker_hard_delete_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_admin_sticker_catalog() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_sticker_active(UUID, BOOLEAN) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Render-ready sticker ingest: source files are transformed locally by the admin UI.
-- Only a compact, canonical WebP render is ever uploaded to private Storage.
UPDATE storage.buckets
SET
  allowed_mime_types = ARRAY['image/webp']::TEXT[],
  file_size_limit = 524288
WHERE id = 'sticker-media';

ALTER TABLE public.stickers
  ALTER COLUMN source_path DROP NOT NULL,
  ALTER COLUMN source_content_type DROP NOT NULL,
  ALTER COLUMN source_content_type DROP DEFAULT;

DROP FUNCTION IF EXISTS public.create_sticker_upload_intent_for_server(
  UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT
);

CREATE FUNCTION public.create_sticker_upload_intent_for_server(
  _actor_user_id UUID,
  _collection_slug TEXT,
  _collection_name TEXT,
  _character_id UUID,
  _sticker_slug TEXT,
  _sticker_name TEXT,
  _source_content_type TEXT DEFAULT 'image/webp'
)
RETURNS TABLE (sticker_id UUID, object_path TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _collection public.sticker_collections%ROWTYPE;
  _id UUID := gen_random_uuid();
  _object_path TEXT;
BEGIN
  PERFORM private.assert_sticker_server_admin(_actor_user_id);

  IF _collection_slug IS NULL OR _collection_slug !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    OR _sticker_slug IS NULL OR _sticker_slug !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    OR char_length(btrim(coalesce(_collection_name, ''))) NOT BETWEEN 1 AND 100
    OR char_length(btrim(coalesce(_sticker_name, ''))) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_sticker_metadata';
  END IF;

  IF _source_content_type <> 'image/webp' THEN
    RAISE EXCEPTION 'invalid_sticker_source_content_type';
  END IF;

  IF _character_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.characters c WHERE c.id = _character_id) THEN
    RAISE EXCEPTION 'character_not_found';
  END IF;

  SELECT * INTO _collection
  FROM public.sticker_collections sc
  WHERE sc.slug = _collection_slug
    AND sc.character_id IS NOT DISTINCT FROM _character_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.sticker_collections (
      slug, name, character_id, is_active, created_by_user_id, updated_by_user_id
    ) VALUES (
      _collection_slug, btrim(_collection_name), _character_id, true,
      _actor_user_id, _actor_user_id
    )
    RETURNING * INTO _collection;
  END IF;

  _object_path := format('collections/%s/stickers/%s/render.webp', _collection.id, _id);
  INSERT INTO public.stickers (
    id, collection_id, slug, name, object_path, source_path, source_content_type,
    content_type, is_active, ingest_status, created_by_user_id, updated_by_user_id
  ) VALUES (
    _id, _collection.id, _sticker_slug, btrim(_sticker_name), _object_path,
    NULL, NULL, 'image/webp', false, 'pending_upload', _actor_user_id, _actor_user_id
  );

  RETURN QUERY SELECT _id, _object_path;
END;
$$;

DROP FUNCTION IF EXISTS public.begin_sticker_processing_for_server(UUID, UUID);

CREATE FUNCTION public.begin_sticker_processing_for_server(
  _actor_user_id UUID,
  _sticker_id UUID
)
RETURNS TABLE (sticker_id UUID, object_path TEXT, already_ready BOOLEAN)
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
    RETURN QUERY SELECT _sticker.id, _sticker.object_path, true;
    RETURN;
  END IF;

  IF _sticker.ingest_status = 'processing'
    AND (
      _sticker.processing_started_at IS NULL
      OR _sticker.processing_started_at > clock_timestamp() - INTERVAL '10 minutes'
    ) THEN
    RAISE EXCEPTION 'sticker_processing_in_progress';
  END IF;

  UPDATE public.stickers s
  SET
    ingest_status = 'processing',
    processing_started_at = clock_timestamp(),
    failed_at = NULL,
    failure_code = NULL,
    updated_at = clock_timestamp(),
    updated_by_user_id = _actor_user_id
  WHERE s.id = _sticker.id;

  RETURN QUERY SELECT _sticker.id, _sticker.object_path, false;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_sticker_processing_for_server(
  _actor_user_id UUID,
  _sticker_id UUID,
  _width INTEGER,
  _height INTEGER,
  _byte_size INTEGER
)
RETURNS TABLE (sticker_id UUID, ingest_status TEXT, already_ready BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _sticker public.stickers%ROWTYPE;
BEGIN
  PERFORM private.assert_sticker_server_admin(_actor_user_id);
  IF _width NOT BETWEEN 1 AND 768
    OR _height NOT BETWEEN 1 AND 768
    OR _byte_size NOT BETWEEN 1 AND 524288 THEN
    RAISE EXCEPTION 'invalid_sticker_render_metadata';
  END IF;

  SELECT * INTO _sticker
  FROM public.stickers s
  WHERE s.id = _sticker_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'sticker_not_found'; END IF;
  IF _sticker.ingest_status = 'ready' THEN
    RETURN QUERY SELECT _sticker.id, _sticker.ingest_status, true;
    RETURN;
  END IF;
  IF _sticker.ingest_status <> 'processing' THEN RAISE EXCEPTION 'sticker_processing_not_started'; END IF;

  UPDATE public.stickers s
  SET
    ingest_status = 'ready',
    width = _width,
    height = _height,
    byte_size = _byte_size,
    processed_at = clock_timestamp(),
    source_path = NULL,
    source_content_type = NULL,
    updated_at = clock_timestamp(),
    updated_by_user_id = _actor_user_id
  WHERE s.id = _sticker.id;

  RETURN QUERY SELECT _sticker.id, 'ready'::TEXT, false;
END;
$$;

REVOKE ALL ON FUNCTION public.create_sticker_upload_intent_for_server(
  UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_sticker_processing_for_server(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_sticker_processing_for_server(UUID, UUID, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_sticker_upload_intent_for_server(
  UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_sticker_processing_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_sticker_processing_for_server(UUID, UUID, INTEGER, INTEGER, INTEGER)
  TO service_role;

NOTIFY pgrst, 'reload schema';

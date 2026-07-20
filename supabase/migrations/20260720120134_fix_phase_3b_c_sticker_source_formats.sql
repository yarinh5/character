-- Accept larger admin-only source files while preserving the compact private render contract.
UPDATE storage.buckets
SET
  allowed_mime_types = ARRAY['image/webp', 'image/png', 'image/jpeg']::TEXT[],
  file_size_limit = 5242880
WHERE id = 'sticker-media';

ALTER TABLE public.stickers
  ADD COLUMN source_content_type TEXT NOT NULL DEFAULT 'image/webp'
    CHECK (source_content_type IN ('image/webp', 'image/png', 'image/jpeg'));

ALTER TABLE public.stickers
  DROP CONSTRAINT IF EXISTS stickers_source_path_check;

ALTER TABLE public.stickers
  ADD CONSTRAINT stickers_source_path_check
  CHECK (
    source_path IS NULL
    OR source_path ~ '^collections/[0-9a-f-]+/stickers/[0-9a-f-]+/source\.(webp|png|jpg|jpeg)$'
  );

DROP FUNCTION IF EXISTS public.create_sticker_upload_intent_for_server(UUID, TEXT, TEXT, UUID, TEXT, TEXT);

CREATE FUNCTION public.create_sticker_upload_intent_for_server(
  _actor_user_id UUID,
  _collection_slug TEXT,
  _collection_name TEXT,
  _character_id UUID,
  _sticker_slug TEXT,
  _sticker_name TEXT,
  _source_content_type TEXT DEFAULT 'image/webp'
)
RETURNS TABLE (sticker_id UUID, source_path TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _collection public.sticker_collections%ROWTYPE;
  _id UUID := gen_random_uuid();
  _source_path TEXT;
  _source_extension TEXT;
BEGIN
  PERFORM private.assert_sticker_server_admin(_actor_user_id);

  IF _collection_slug IS NULL OR _collection_slug !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    OR _sticker_slug IS NULL OR _sticker_slug !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    OR char_length(btrim(coalesce(_collection_name, ''))) NOT BETWEEN 1 AND 100
    OR char_length(btrim(coalesce(_sticker_name, ''))) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_sticker_metadata';
  END IF;

  IF _source_content_type NOT IN ('image/webp', 'image/png', 'image/jpeg') THEN
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

  _source_extension := CASE _source_content_type
    WHEN 'image/webp' THEN 'webp'
    WHEN 'image/png' THEN 'png'
    WHEN 'image/jpeg' THEN 'jpg'
  END;
  _source_path := format(
    'collections/%s/stickers/%s/source.%s', _collection.id, _id, _source_extension
  );

  INSERT INTO public.stickers (
    id, collection_id, slug, name, object_path, source_path, source_content_type,
    content_type, is_active, ingest_status, created_by_user_id, updated_by_user_id
  ) VALUES (
    _id, _collection.id, _sticker_slug, btrim(_sticker_name),
    format('collections/%s/stickers/%s/render.webp', _collection.id, _id),
    _source_path, _source_content_type, 'image/webp', false, 'pending_upload',
    _actor_user_id, _actor_user_id
  );

  RETURN QUERY SELECT _id, _source_path;
END;
$$;

REVOKE ALL ON FUNCTION public.create_sticker_upload_intent_for_server(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_sticker_upload_intent_for_server(UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT)
  TO service_role;

NOTIFY pgrst, 'reload schema';

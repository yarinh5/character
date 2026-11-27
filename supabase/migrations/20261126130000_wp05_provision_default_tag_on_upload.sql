-- Initialize the default media tag when a character receives its first upload.
CREATE OR REPLACE FUNCTION public.create_character_media_upload_intent_for_server(
  _actor_user_id uuid,
  _character_id uuid,
  _content_type text,
  _display_name text DEFAULT NULL
)
RETURNS TABLE (asset_id uuid, source_path text, content_type text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _asset public.character_media_assets%ROWTYPE;
  _default_tag_id uuid;
  _extension text;
BEGIN
  IF auth.role() <> 'service_role' OR _actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles role
    WHERE role.user_id = _actor_user_id AND role.role = 'admin'
  ) THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF _content_type NOT IN ('image/jpeg', 'image/png', 'image/webp') THEN
    RAISE EXCEPTION 'unsupported_media_content_type';
  END IF;
  PERFORM 1 FROM public.characters character WHERE character.id = _character_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'character_not_found'; END IF;
  SELECT tag.id INTO _default_tag_id FROM public.media_tags tag
  WHERE tag.character_id = _character_id AND tag.is_default
  ORDER BY tag.created_at, tag.id LIMIT 1;
  IF _default_tag_id IS NULL THEN
    -- Provision once without renaming or promoting an existing user tag.
    FOR attempt IN 1..2 LOOP
      INSERT INTO public.media_tags (
        character_id, name, is_default, created_by_user_id, updated_by_user_id
      )
      SELECT _character_id, candidate.name, true, _actor_user_id, _actor_user_id
      FROM generate_series(1, 1 + (
        SELECT count(*)::integer FROM public.media_tags WHERE character_id = _character_id
      )) AS suffix(number)
      CROSS JOIN LATERAL (
        SELECT CASE WHEN suffix.number = 1 THEN 'מדיה כללית'
          ELSE format('מדיה כללית %s', suffix.number) END AS name
      ) candidate
      WHERE NOT EXISTS (
        SELECT 1 FROM public.media_tags existing
        WHERE existing.character_id = _character_id AND lower(existing.name) = lower(candidate.name)
      )
      ORDER BY suffix.number
      LIMIT 1
      ON CONFLICT DO NOTHING
      RETURNING id INTO _default_tag_id;
      IF _default_tag_id IS NULL THEN
        -- A tag added or renamed while selecting the name can claim it first.
        SELECT tag.id INTO _default_tag_id FROM public.media_tags tag
        WHERE tag.character_id = _character_id AND tag.is_default;
      END IF;
      EXIT WHEN _default_tag_id IS NOT NULL;
    END LOOP;
    IF _default_tag_id IS NULL THEN RAISE EXCEPTION 'default_media_tag_required'; END IF;
  END IF;
  _extension := CASE _content_type WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' ELSE 'webp' END;
  INSERT INTO public.character_media_assets (
    character_id, media_tag_id, source_path, preview_path, content_type,
    display_name, created_by_user_id, updated_by_user_id
  ) VALUES (
    _character_id, _default_tag_id,
    format('assets/%s/source.%s', gen_random_uuid(), _extension), NULL,
    _content_type, NULLIF(btrim(_display_name), ''), _actor_user_id, _actor_user_id
  ) RETURNING * INTO _asset;
  UPDATE public.character_media_assets
  SET source_path = format('assets/%s/source.%s', _asset.id, _extension),
      preview_path = format('assets/%s/preview.webp', _asset.id)
  WHERE id = _asset.id RETURNING * INTO _asset;
  INSERT INTO public.character_media_asset_characters
    (media_asset_id, character_id, created_by_user_id)
  VALUES (_asset.id, _character_id, _actor_user_id);
  INSERT INTO public.character_media_asset_tags
    (media_asset_id, media_tag_id, created_by_user_id)
  VALUES (_asset.id, _default_tag_id, _actor_user_id);
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _actor_user_id,
    'character_media_asset.upload_intent_created',
    'character_media_asset',
    _asset.id::text,
    jsonb_build_object('character_id', _character_id, 'content_type', _content_type)
  );
  RETURN QUERY SELECT _asset.id, _asset.source_path, _asset.content_type;
END;
$$;

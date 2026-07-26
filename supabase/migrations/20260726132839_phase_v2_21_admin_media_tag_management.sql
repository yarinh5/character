-- Phase V2-21: manage character media tags through narrow admin-only RPCs.

-- Tag writes are intentionally available only through the audited RPCs below.
DROP POLICY IF EXISTS "Admins manage media tags" ON public.media_tags;
CREATE POLICY "Admins view media tags"
  ON public.media_tags
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

REVOKE INSERT, UPDATE, DELETE ON TABLE public.media_tags FROM authenticated;

CREATE OR REPLACE FUNCTION public.get_admin_media_tags(
  _character_id UUID
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  sort_order INTEGER,
  is_default BOOLEAN,
  asset_count BIGINT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
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
    tag.id,
    tag.name,
    tag.sort_order,
    tag.is_default,
    COUNT(asset.id),
    tag.created_at,
    tag.updated_at
  FROM public.media_tags tag
  LEFT JOIN public.character_media_assets asset ON asset.media_tag_id = tag.id
  WHERE tag.character_id = _character_id
  GROUP BY tag.id
  ORDER BY tag.is_default DESC, tag.sort_order ASC, tag.name ASC, tag.id ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_admin_media_tag(
  _character_id UUID,
  _name TEXT,
  _sort_order INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _admin_id UUID := auth.uid();
  _name_clean TEXT := btrim(coalesce(_name, ''));
  _sort_order_value INTEGER;
  _tag public.media_tags%ROWTYPE;
BEGIN
  IF _admin_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF _character_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.characters WHERE id = _character_id) THEN
    RAISE EXCEPTION 'character_not_found';
  END IF;

  IF char_length(_name_clean) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'media_tag_name_invalid';
  END IF;

  IF _sort_order IS NOT NULL AND _sort_order < 0 THEN
    RAISE EXCEPTION 'media_tag_sort_order_invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.media_tags
    WHERE character_id = _character_id
      AND lower(name) = lower(_name_clean)
  ) THEN
    RAISE EXCEPTION 'media_tag_name_conflict';
  END IF;

  SELECT COALESCE(_sort_order, COALESCE(MAX(sort_order) + 1, 0))
  INTO _sort_order_value
  FROM public.media_tags
  WHERE character_id = _character_id;

  INSERT INTO public.media_tags (
    character_id,
    name,
    sort_order,
    created_by_user_id,
    updated_by_user_id
  )
  VALUES (
    _character_id,
    _name_clean,
    _sort_order_value,
    _admin_id,
    _admin_id
  )
  RETURNING * INTO _tag;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'media_tag.created',
    'media_tag',
    _tag.id::TEXT,
    jsonb_build_object('character_id', _character_id, 'name', _tag.name, 'sort_order', _tag.sort_order)
  );

  RETURN jsonb_build_object(
    'id', _tag.id,
    'name', _tag.name,
    'sort_order', _tag.sort_order,
    'is_default', _tag.is_default
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_admin_media_tag(
  _tag_id UUID,
  _name TEXT,
  _sort_order INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _admin_id UUID := auth.uid();
  _name_clean TEXT := btrim(coalesce(_name, ''));
  _tag public.media_tags%ROWTYPE;
BEGIN
  IF _admin_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF char_length(_name_clean) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'media_tag_name_invalid';
  END IF;

  IF _sort_order IS NOT NULL AND _sort_order < 0 THEN
    RAISE EXCEPTION 'media_tag_sort_order_invalid';
  END IF;

  SELECT *
  INTO _tag
  FROM public.media_tags
  WHERE id = _tag_id
  FOR UPDATE;

  IF NOT FOUND OR _tag.character_id IS NULL THEN
    RAISE EXCEPTION 'media_tag_not_found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.media_tags
    WHERE character_id = _tag.character_id
      AND lower(name) = lower(_name_clean)
      AND id <> _tag.id
  ) THEN
    RAISE EXCEPTION 'media_tag_name_conflict';
  END IF;

  UPDATE public.media_tags
  SET
    name = _name_clean,
    sort_order = COALESCE(_sort_order, _tag.sort_order),
    updated_by_user_id = _admin_id
  WHERE id = _tag.id
  RETURNING * INTO _tag;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'media_tag.updated',
    'media_tag',
    _tag.id::TEXT,
    jsonb_build_object('character_id', _tag.character_id, 'name', _tag.name, 'sort_order', _tag.sort_order)
  );

  RETURN jsonb_build_object(
    'id', _tag.id,
    'name', _tag.name,
    'sort_order', _tag.sort_order,
    'is_default', _tag.is_default
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_admin_media_tag(
  _tag_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _admin_id UUID := auth.uid();
  _tag public.media_tags%ROWTYPE;
BEGIN
  IF _admin_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  SELECT *
  INTO _tag
  FROM public.media_tags
  WHERE id = _tag_id
  FOR UPDATE;

  IF NOT FOUND OR _tag.character_id IS NULL THEN
    RAISE EXCEPTION 'media_tag_not_found';
  END IF;

  IF _tag.is_default THEN
    RAISE EXCEPTION 'default_media_tag_cannot_be_deleted';
  END IF;

  IF EXISTS (SELECT 1 FROM public.character_media_assets WHERE media_tag_id = _tag.id) THEN
    RAISE EXCEPTION 'media_tag_in_use';
  END IF;

  DELETE FROM public.media_tags WHERE id = _tag.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'media_tag.deleted',
    'media_tag',
    _tag.id::TEXT,
    jsonb_build_object('character_id', _tag.character_id, 'name', _tag.name)
  );

  RETURN jsonb_build_object('id', _tag.id, 'deleted', TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_admin_media_asset_tag(
  _asset_id UUID,
  _media_tag_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _admin_id UUID := auth.uid();
  _asset public.character_media_assets%ROWTYPE;
  _tag public.media_tags%ROWTYPE;
BEGIN
  IF _admin_id IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  SELECT *
  INTO _asset
  FROM public.character_media_assets
  WHERE id = _asset_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'character_media_asset_not_found';
  END IF;

  SELECT *
  INTO _tag
  FROM public.media_tags
  WHERE id = _media_tag_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_tag_not_found';
  END IF;

  -- The asset trigger enforces this invariant too. Keep the RPC error explicit
  -- and never allow the global placeholder tag to be assigned to an asset.
  IF _tag.character_id IS NULL OR _tag.character_id <> _asset.character_id THEN
    RAISE EXCEPTION 'media_tag_character_mismatch';
  END IF;

  UPDATE public.character_media_assets
  SET media_tag_id = _tag.id, updated_by_user_id = _admin_id
  WHERE id = _asset.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'character_media_asset.tag_assigned',
    'character_media_asset',
    _asset.id::TEXT,
    jsonb_build_object('character_id', _asset.character_id, 'media_tag_id', _tag.id)
  );

  RETURN jsonb_build_object(
    'asset_id', _asset.id,
    'media_tag_id', _tag.id,
    'media_tag_name', _tag.name
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_media_tags(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_admin_media_tag(UUID, TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_admin_media_tag(UUID, TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_admin_media_tag(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assign_admin_media_asset_tag(UUID, UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_admin_media_tags(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_admin_media_tag(UUID, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_admin_media_tag(UUID, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_admin_media_tag(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_admin_media_asset_tag(UUID, UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

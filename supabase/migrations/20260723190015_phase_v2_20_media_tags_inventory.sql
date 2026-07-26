-- Phase V2-20: introduce per-character media tags without changing the
-- existing flat delivery/reservation catalog contract.

CREATE TABLE public.media_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id UUID REFERENCES public.characters(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  is_default BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  CHECK (character_id IS NOT NULL OR is_default = true)
);

CREATE UNIQUE INDEX media_tags_one_global_default_idx
  ON public.media_tags (is_default)
  WHERE character_id IS NULL AND is_default = true;

CREATE UNIQUE INDEX media_tags_one_default_per_character_idx
  ON public.media_tags (character_id)
  WHERE character_id IS NOT NULL AND is_default = true;

CREATE UNIQUE INDEX media_tags_character_name_idx
  ON public.media_tags (character_id, lower(name))
  WHERE character_id IS NOT NULL;

CREATE INDEX media_tags_character_catalog_idx
  ON public.media_tags (character_id, sort_order, created_at)
  WHERE character_id IS NOT NULL;

ALTER TABLE public.media_tags ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.media_tags FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.media_tags TO authenticated;

CREATE POLICY "Admins manage media tags"
  ON public.media_tags
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "Operators view assigned character media tags"
  ON public.media_tags
  FOR SELECT TO authenticated
  USING (
    character_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.operators operator_record
      JOIN public.character_operator_assignments assignment
        ON assignment.operator_id = operator_record.id
      WHERE operator_record.user_id = auth.uid()
        AND operator_record.is_active = true
        AND assignment.character_id = media_tags.character_id
    )
  );

CREATE OR REPLACE FUNCTION private.touch_media_tag_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_media_tags_updated_at
  BEFORE UPDATE ON public.media_tags
  FOR EACH ROW
  EXECUTE FUNCTION private.touch_media_tag_updated_at();

-- The global tag is intentionally empty: character assets are always placed
-- in their character's own default tag below.
INSERT INTO public.media_tags (character_id, name, is_default)
VALUES (NULL, 'כללי', true)
ON CONFLICT DO NOTHING;

INSERT INTO public.media_tags (character_id, name, is_default)
SELECT DISTINCT asset.character_id, 'מדיה כללית', true
FROM public.character_media_assets asset
ON CONFLICT DO NOTHING;

ALTER TABLE public.character_media_assets
  ADD COLUMN media_tag_id UUID;

UPDATE public.character_media_assets asset
SET media_tag_id = tag.id
FROM public.media_tags tag
WHERE asset.media_tag_id IS NULL
  AND tag.character_id = asset.character_id
  AND tag.is_default = true;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.character_media_assets
    WHERE media_tag_id IS NULL
  ) THEN
    RAISE EXCEPTION 'character_media_asset_tag_backfill_incomplete';
  END IF;
END;
$$;

ALTER TABLE public.character_media_assets
  ALTER COLUMN media_tag_id SET NOT NULL,
  ADD CONSTRAINT character_media_assets_media_tag_id_fkey
    FOREIGN KEY (media_tag_id)
    REFERENCES public.media_tags(id)
    ON DELETE RESTRICT;

CREATE INDEX character_media_assets_media_tag_catalog_idx
  ON public.character_media_assets (media_tag_id, created_at DESC);

CREATE OR REPLACE FUNCTION private.assign_character_media_asset_default_tag()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  _tag_character_id UUID;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.character_id IS DISTINCT FROM OLD.character_id
     AND NEW.media_tag_id = OLD.media_tag_id THEN
    NEW.media_tag_id := NULL;
  END IF;

  IF NEW.media_tag_id IS NULL THEN
    SELECT tag.id
    INTO NEW.media_tag_id
    FROM public.media_tags tag
    WHERE tag.character_id = NEW.character_id
      AND tag.is_default = true;

    IF NEW.media_tag_id IS NULL THEN
      BEGIN
        INSERT INTO public.media_tags (character_id, name, is_default)
        VALUES (NEW.character_id, 'מדיה כללית', true)
        RETURNING id INTO NEW.media_tag_id;
      EXCEPTION WHEN unique_violation THEN
        SELECT tag.id
        INTO NEW.media_tag_id
        FROM public.media_tags tag
        WHERE tag.character_id = NEW.character_id
          AND tag.is_default = true;
      END;
    END IF;
  END IF;

  SELECT tag.character_id
  INTO _tag_character_id
  FROM public.media_tags tag
  WHERE tag.id = NEW.media_tag_id;

  IF _tag_character_id IS NULL OR _tag_character_id <> NEW.character_id THEN
    RAISE EXCEPTION 'character_media_tag_character_mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_character_media_assets_assign_default_tag
  BEFORE INSERT OR UPDATE OF character_id, media_tag_id ON public.character_media_assets
  FOR EACH ROW
  EXECUTE FUNCTION private.assign_character_media_asset_default_tag();

-- Keep the existing flat admin catalog usable while making the tag mapping
-- available to an authorized admin. The operator catalog intentionally stays
-- unchanged so tags do not alter delivery or reservation behavior.
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
  processing_error_code TEXT,
  media_tag_id UUID,
  media_tag_name TEXT
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
    asset.processing_error_code,
    asset.media_tag_id,
    tag.name
  FROM public.character_media_assets asset
  JOIN public.media_tags tag ON tag.id = asset.media_tag_id
  WHERE asset.character_id = _character_id
  ORDER BY asset.created_at DESC, asset.id DESC;
END;
$$;

REVOKE ALL ON FUNCTION private.touch_media_tag_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assign_character_media_asset_default_tag() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_admin_character_media_assets(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_character_media_assets(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

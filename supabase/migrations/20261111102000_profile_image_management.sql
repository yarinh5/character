-- Client profile image management: one atomic server boundary for ordering,
-- primary selection and profile/avatar projection. Physical Storage deletion is
-- deliberately deferred until a trusted worker can prove there are no remaining
-- references; the client never deletes a URL-derived object directly.

UPDATE storage.buckets
SET file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']::TEXT[]
WHERE id = 'user-avatars';

CREATE TABLE IF NOT EXISTS private.client_profile_image_cleanup_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bucket_id TEXT NOT NULL DEFAULT 'user-avatars' CHECK (bucket_id = 'user-avatars'),
  object_path TEXT NOT NULL,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_reference_check'
    CHECK (status IN ('pending_reference_check', 'claimed', 'deleted', 'retained')),
  queued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (owner_user_id, bucket_id, object_path, status)
);

REVOKE ALL ON TABLE private.client_profile_image_cleanup_queue
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE private.client_profile_image_cleanup_queue
  TO service_role;

CREATE OR REPLACE FUNCTION private.profile_image_object_path(
  _url TEXT,
  _owner_user_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = public, storage, pg_temp
AS $$
DECLARE
  _marker CONSTANT TEXT := '/storage/v1/object/public/user-avatars/';
  _path TEXT;
BEGIN
  IF NULLIF(btrim(_url), '') IS NULL
    OR strpos(_url, _marker) = 0 THEN
    RETURN NULL;
  END IF;

  _path := split_part(split_part(_url, _marker, 2), '?', 1);
  IF NULLIF(_path, '') IS NULL
    OR (storage.foldername(_path))[1] IS DISTINCT FROM _owner_user_id::TEXT THEN
    RETURN NULL;
  END IF;
  RETURN _path;
END;
$$;

CREATE OR REPLACE FUNCTION private.validate_client_profile_images()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, storage, pg_temp
AS $$
DECLARE
  _old_urls TEXT[] := CASE
    WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.profile_image_urls, '{}'::TEXT[])
    ELSE '{}'::TEXT[]
  END;
  _new_url TEXT;
  _object_path TEXT;
  _metadata JSONB;
  _owner_id TEXT;
  _mime TEXT;
  _size BIGINT;
BEGIN
  NEW.profile_image_urls := COALESCE(NEW.profile_image_urls, '{}'::TEXT[]);

  IF EXISTS (
    SELECT 1 FROM unnest(NEW.profile_image_urls) image_url
    WHERE NULLIF(btrim(image_url), '') IS NULL
  ) OR cardinality(NEW.profile_image_urls) <> (
    SELECT count(DISTINCT image_url) FROM unnest(NEW.profile_image_urls) image_url
  ) THEN
    RAISE EXCEPTION 'invalid_profile_image_urls';
  END IF;

  IF cardinality(NEW.profile_image_urls) = 0 THEN
    NEW.profile_image_url := NULL;
  ELSE
    NEW.profile_image_url := COALESCE(
      NULLIF(btrim(NEW.profile_image_url), ''),
      NEW.profile_image_urls[1]
    );
    IF NOT NEW.profile_image_url = ANY (NEW.profile_image_urls) THEN
      RAISE EXCEPTION 'profile_primary_image_not_in_ordered_images';
    END IF;
  END IF;

  IF cardinality(_old_urls) > 6 THEN
    IF EXISTS (
      SELECT 1 FROM unnest(NEW.profile_image_urls) image_url
      WHERE NOT image_url = ANY (_old_urls)
    ) THEN
      RAISE EXCEPTION 'legacy_profile_image_limit_exceeded';
    END IF;
  ELSIF cardinality(NEW.profile_image_urls) > 6 THEN
    RAISE EXCEPTION 'profile_image_limit_exceeded';
  END IF;

  FOR _new_url IN
    SELECT image_url
    FROM unnest(NEW.profile_image_urls) image_url
    WHERE NOT image_url = ANY (_old_urls)
  LOOP
    _object_path := private.profile_image_object_path(_new_url, NEW.user_id);
    IF _object_path IS NULL THEN
      RAISE EXCEPTION 'profile_image_not_owned';
    END IF;

    SELECT object.metadata, object.owner_id
    INTO _metadata, _owner_id
    FROM storage.objects object
    WHERE object.bucket_id = 'user-avatars'
      AND object.name = _object_path;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'profile_image_object_missing';
    END IF;
    IF _owner_id IS DISTINCT FROM NEW.user_id::TEXT THEN
      RAISE EXCEPTION 'profile_image_not_owned';
    END IF;

    _mime := _metadata ->> 'mimetype';
    _size := CASE
      WHEN COALESCE(_metadata ->> 'size', '') ~ '^[0-9]+$'
        THEN (_metadata ->> 'size')::BIGINT
      ELSE NULL
    END;
    IF _mime NOT IN ('image/jpeg', 'image/png', 'image/webp')
      OR COALESCE(_size, 0) <= 0
      OR _size > 5242880 THEN
      RAISE EXCEPTION 'profile_image_metadata_invalid';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.record_client_profile_image_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, storage, pg_temp
AS $$
DECLARE
  _removed_url TEXT;
  _object_path TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR _removed_url IN
      SELECT image_url
      FROM unnest(COALESCE(OLD.profile_image_urls, '{}'::TEXT[])) image_url
      WHERE NOT image_url = ANY (COALESCE(NEW.profile_image_urls, '{}'::TEXT[]))
    LOOP
      _object_path := private.profile_image_object_path(_removed_url, NEW.user_id);
      IF _object_path IS NOT NULL AND EXISTS (
        SELECT 1 FROM storage.objects object
        WHERE object.bucket_id = 'user-avatars'
          AND object.name = _object_path
          AND object.owner_id = NEW.user_id::TEXT
      ) THEN
        INSERT INTO private.client_profile_image_cleanup_queue (
          owner_user_id, object_path, source_url
        ) VALUES (
          NEW.user_id, _object_path, _removed_url
        ) ON CONFLICT (owner_user_id, bucket_id, object_path, status) DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    auth.uid(),
    'client_profile.images_updated',
    'client_profile',
    NEW.user_id::TEXT,
    jsonb_build_object(
      'image_count', cardinality(NEW.profile_image_urls),
      'primary_changed', CASE
        WHEN TG_OP = 'INSERT' THEN NEW.profile_image_url IS NOT NULL
        ELSE OLD.profile_image_url IS DISTINCT FROM NEW.profile_image_url
      END
    )
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.sync_client_profile_avatar()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  UPDATE public.profiles
  SET avatar_url = NEW.profile_image_url
  WHERE user_id = NEW.user_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS validate_client_profile_images ON public.client_profiles;
CREATE TRIGGER validate_client_profile_images
  BEFORE INSERT OR UPDATE OF profile_image_url, profile_image_urls
  ON public.client_profiles
  FOR EACH ROW EXECUTE FUNCTION private.validate_client_profile_images();

DROP TRIGGER IF EXISTS record_client_profile_image_changes ON public.client_profiles;
CREATE TRIGGER record_client_profile_image_changes
  AFTER UPDATE OF profile_image_url, profile_image_urls
  ON public.client_profiles
  FOR EACH ROW
  WHEN (
    OLD.profile_image_url IS DISTINCT FROM NEW.profile_image_url
    OR OLD.profile_image_urls IS DISTINCT FROM NEW.profile_image_urls
  )
  EXECUTE FUNCTION private.record_client_profile_image_changes();

DROP TRIGGER IF EXISTS sync_client_profile_avatar ON public.client_profiles;
CREATE CONSTRAINT TRIGGER sync_client_profile_avatar
  AFTER INSERT OR UPDATE OF profile_image_url, profile_image_urls
  ON public.client_profiles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.sync_client_profile_avatar();

CREATE OR REPLACE FUNCTION public.update_client_profile_images(
  _profile_image_urls TEXT[],
  _profile_image_url TEXT DEFAULT NULL
)
RETURNS TABLE (
  profile_image_url TEXT,
  profile_image_urls TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client_id UUID := auth.uid();
BEGIN
  IF _client_id IS NULL
    OR NOT public.has_current_user_role('client'::public.app_role) THEN
    RAISE EXCEPTION 'client_profile_required' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.client_profiles profile
  WHERE profile.user_id = _client_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'client_profile_not_found';
  END IF;

  RETURN QUERY
  UPDATE public.client_profiles profile
  SET profile_image_url = NULLIF(btrim(_profile_image_url), ''),
      profile_image_urls = COALESCE(_profile_image_urls, '{}'::TEXT[]),
      updated_at = clock_timestamp()
  WHERE profile.user_id = _client_id
  RETURNING profile.profile_image_url, profile.profile_image_urls;
END;
$$;

REVOKE ALL ON FUNCTION private.profile_image_object_path(TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.validate_client_profile_images()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.record_client_profile_image_changes()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.sync_client_profile_avatar()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_client_profile_images(TEXT[], TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_client_profile_images(TEXT[], TEXT)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

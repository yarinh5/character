-- WP06-B: bounded physical cleanup for expired client media, abandoned
-- finalize artifacts and unreferenced client profile images. This migration
-- installs contracts only; it does not schedule or invoke the worker.

ALTER TABLE private.client_profile_image_cleanup_queue
  DROP CONSTRAINT IF EXISTS client_profile_image_cleanup_queue_status_check;

UPDATE private.client_profile_image_cleanup_queue
SET status = 'pending_reference_check',
    claimed_at = NULL
WHERE status = 'claimed';

ALTER TABLE private.client_profile_image_cleanup_queue
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS storage_object_id UUID,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS resolution_reason TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();

ALTER TABLE private.client_profile_image_cleanup_queue
  ADD CONSTRAINT client_profile_image_cleanup_queue_status_check
    CHECK (status IN (
      'pending_reference_check', 'claimed', 'failed', 'blocked',
      'deleted', 'retained', 'superseded'
    )),
  ADD CONSTRAINT client_profile_image_cleanup_queue_attempts_check
    CHECK (attempts BETWEEN 0 AND 8),
  ADD CONSTRAINT client_profile_image_cleanup_queue_claim_shape_check
    CHECK (
      (status = 'claimed'
        AND claimed_at IS NOT NULL
        AND claim_token IS NOT NULL
        AND claim_expires_at IS NOT NULL
        AND storage_object_id IS NOT NULL)
      OR
      (status <> 'claimed'
        AND claim_token IS NULL
        AND claim_expires_at IS NULL)
    );

WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY owner_user_id, bucket_id, object_path
      ORDER BY queued_at, id
    ) AS position
  FROM private.client_profile_image_cleanup_queue
  WHERE status IN ('pending_reference_check', 'failed', 'blocked')
)
UPDATE private.client_profile_image_cleanup_queue queue
SET status = 'superseded',
    resolution_reason = 'duplicate_queue_entry',
    completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
FROM ranked
WHERE queue.id = ranked.id
  AND ranked.position > 1;

DO $migration$
DECLARE
  _constraint_name TEXT;
BEGIN
  FOR _constraint_name IN
    SELECT constraint_row.conname
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'private.client_profile_image_cleanup_queue'::regclass
      AND constraint_row.contype = 'u'
  LOOP
    EXECUTE format(
      'ALTER TABLE private.client_profile_image_cleanup_queue DROP CONSTRAINT %I',
      _constraint_name
    );
  END LOOP;
END;
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS client_profile_image_cleanup_active_object_uidx
  ON private.client_profile_image_cleanup_queue(owner_user_id, bucket_id, object_path)
  WHERE status IN ('pending_reference_check', 'claimed', 'failed', 'blocked');

CREATE INDEX IF NOT EXISTS client_profile_image_cleanup_due_idx
  ON private.client_profile_image_cleanup_queue(next_attempt_at, queued_at, id)
  WHERE status IN ('pending_reference_check', 'failed');

CREATE INDEX IF NOT EXISTS client_profile_image_cleanup_stale_claim_idx
  ON private.client_profile_image_cleanup_queue(claim_expires_at, claimed_at, id)
  WHERE status = 'claimed';

CREATE OR REPLACE FUNCTION private.client_profile_image_is_referenced(
  _owner_user_id UUID,
  _object_path TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.client_profiles profile
    WHERE profile.user_id = _owner_user_id
      AND (
        private.profile_image_object_path(profile.profile_image_url, _owner_user_id) = _object_path
        OR EXISTS (
          SELECT 1
          FROM unnest(COALESCE(profile.profile_image_urls, '{}'::TEXT[])) image_url
          WHERE private.profile_image_object_path(image_url, _owner_user_id) = _object_path
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.profiles profile
    WHERE profile.user_id = _owner_user_id
      AND private.profile_image_object_path(profile.avatar_url, _owner_user_id) = _object_path
  );
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
        )
        ON CONFLICT (owner_user_id, bucket_id, object_path)
          WHERE status IN ('pending_reference_check', 'claimed', 'failed', 'blocked')
        DO NOTHING;
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

CREATE OR REPLACE FUNCTION private.guard_client_profile_image_cleanup_reference()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _old_urls TEXT[] := CASE
    WHEN TG_OP = 'UPDATE' THEN ARRAY(
      SELECT DISTINCT value
      FROM unnest(
        COALESCE(OLD.profile_image_urls, '{}'::TEXT[])
        || CASE WHEN OLD.profile_image_url IS NULL THEN '{}'::TEXT[] ELSE ARRAY[OLD.profile_image_url] END
      ) value
    )
    ELSE '{}'::TEXT[]
  END;
  _url TEXT;
  _object_path TEXT;
BEGIN
  FOR _url IN
    SELECT DISTINCT value
    FROM unnest(
      COALESCE(NEW.profile_image_urls, '{}'::TEXT[])
      || CASE WHEN NEW.profile_image_url IS NULL THEN '{}'::TEXT[] ELSE ARRAY[NEW.profile_image_url] END
    ) value
    WHERE NOT value = ANY (_old_urls)
  LOOP
    _object_path := private.profile_image_object_path(_url, NEW.user_id);
    IF _object_path IS NULL THEN CONTINUE; END IF;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(NEW.user_id::TEXT || '|user-avatars|' || _object_path, 0)
    );
    IF EXISTS (
      SELECT 1
      FROM private.client_profile_image_cleanup_queue queue
      WHERE queue.owner_user_id = NEW.user_id
        AND queue.bucket_id = 'user-avatars'
        AND queue.object_path = _object_path
        AND queue.status = 'claimed'
    ) THEN
      RAISE EXCEPTION 'profile_image_cleanup_in_progress';
    END IF;

    UPDATE private.client_profile_image_cleanup_queue queue
    SET status = 'retained',
        resolution_reason = 'profile_reference_restored',
        completed_at = clock_timestamp(),
        last_error_code = NULL,
        updated_at = clock_timestamp()
    WHERE queue.owner_user_id = NEW.user_id
      AND queue.bucket_id = 'user-avatars'
      AND queue.object_path = _object_path
      AND queue.status IN ('pending_reference_check', 'failed', 'blocked');
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.guard_profile_avatar_cleanup_reference()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _object_path TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.avatar_url IS NOT DISTINCT FROM OLD.avatar_url THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.avatar_url IS NULL THEN
    RETURN NEW;
  END IF;
  _object_path := private.profile_image_object_path(NEW.avatar_url, NEW.user_id);
  IF _object_path IS NULL THEN RETURN NEW; END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.user_id::TEXT || '|user-avatars|' || _object_path, 0)
  );
  IF EXISTS (
    SELECT 1
    FROM private.client_profile_image_cleanup_queue queue
    WHERE queue.owner_user_id = NEW.user_id
      AND queue.bucket_id = 'user-avatars'
      AND queue.object_path = _object_path
      AND queue.status = 'claimed'
  ) THEN
    RAISE EXCEPTION 'profile_image_cleanup_in_progress';
  END IF;

  UPDATE private.client_profile_image_cleanup_queue queue
  SET status = 'retained',
      resolution_reason = 'avatar_reference_restored',
      completed_at = clock_timestamp(),
      last_error_code = NULL,
      updated_at = clock_timestamp()
  WHERE queue.owner_user_id = NEW.user_id
    AND queue.bucket_id = 'user-avatars'
    AND queue.object_path = _object_path
    AND queue.status IN ('pending_reference_check', 'failed', 'blocked');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_client_profile_image_cleanup_reference ON public.client_profiles;
CREATE TRIGGER guard_client_profile_image_cleanup_reference
  BEFORE INSERT OR UPDATE OF profile_image_url, profile_image_urls
  ON public.client_profiles
  FOR EACH ROW EXECUTE FUNCTION private.guard_client_profile_image_cleanup_reference();

DROP TRIGGER IF EXISTS guard_profile_avatar_cleanup_reference ON public.profiles;
CREATE TRIGGER guard_profile_avatar_cleanup_reference
  BEFORE INSERT OR UPDATE OF avatar_url
  ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.guard_profile_avatar_cleanup_reference();

CREATE OR REPLACE FUNCTION public.claim_client_profile_image_cleanup_for_server(
  _limit INTEGER DEFAULT 25
)
RETURNS TABLE (
  queue_id UUID,
  owner_user_id UUID,
  bucket_id TEXT,
  object_path TEXT,
  claim_token UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, storage, pg_temp
AS $$
DECLARE
  _now TIMESTAMPTZ := clock_timestamp();
  _queue private.client_profile_image_cleanup_queue%ROWTYPE;
  _storage_object_id UUID;
  _storage_owner_id TEXT;
  _new_token UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;

  UPDATE private.client_profile_image_cleanup_queue queue
  SET status = 'blocked',
      resolution_reason = 'retry_limit_reached_after_lease_expiry',
      completed_at = _now,
      claim_token = NULL,
      claim_expires_at = NULL,
      last_error_code = COALESCE(queue.last_error_code, 'worker_lease_expired'),
      updated_at = _now
  WHERE queue.status = 'claimed'
    AND queue.attempts >= 8
    AND queue.claim_expires_at <= _now;

  FOR _queue IN
    SELECT queue.*
    FROM private.client_profile_image_cleanup_queue queue
    WHERE queue.attempts < 8
      AND (
        (queue.status IN ('pending_reference_check', 'failed')
          AND queue.next_attempt_at <= _now)
        OR (queue.status = 'claimed' AND queue.claim_expires_at <= _now)
      )
    ORDER BY COALESCE(queue.claim_expires_at, queue.next_attempt_at), queue.queued_at, queue.id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(_limit, 25), 1), 100)
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        _queue.owner_user_id::TEXT || '|' || _queue.bucket_id || '|' || _queue.object_path,
        0
      )
    );
    PERFORM 1 FROM public.client_profiles profile
      WHERE profile.user_id = _queue.owner_user_id FOR UPDATE;
    PERFORM 1 FROM public.profiles profile
      WHERE profile.user_id = _queue.owner_user_id FOR UPDATE;

    IF private.client_profile_image_is_referenced(_queue.owner_user_id, _queue.object_path) THEN
      UPDATE private.client_profile_image_cleanup_queue queue
      SET status = 'retained',
          resolution_reason = 'active_profile_reference',
          completed_at = _now,
          claim_token = NULL,
          claim_expires_at = NULL,
          updated_at = _now
      WHERE queue.id = _queue.id;
      CONTINUE;
    END IF;

    IF _queue.bucket_id <> 'user-avatars'
      OR (storage.foldername(_queue.object_path))[1] IS DISTINCT FROM _queue.owner_user_id::TEXT THEN
      UPDATE private.client_profile_image_cleanup_queue queue
      SET status = 'blocked',
          resolution_reason = 'unproven_canonical_owner_path',
          completed_at = _now,
          claim_token = NULL,
          claim_expires_at = NULL,
          updated_at = _now
      WHERE queue.id = _queue.id;
      CONTINUE;
    END IF;

    SELECT object.id, object.owner_id
    INTO _storage_object_id, _storage_owner_id
    FROM storage.objects object
    WHERE object.bucket_id = _queue.bucket_id
      AND object.name = _queue.object_path;

    IF NOT FOUND THEN
      UPDATE private.client_profile_image_cleanup_queue queue
      SET status = 'deleted',
          resolution_reason = 'storage_object_already_absent',
          completed_at = _now,
          claim_token = NULL,
          claim_expires_at = NULL,
          storage_object_id = NULL,
          last_error_code = NULL,
          updated_at = _now
      WHERE queue.id = _queue.id;
      CONTINUE;
    END IF;

    IF _storage_owner_id IS DISTINCT FROM _queue.owner_user_id::TEXT THEN
      UPDATE private.client_profile_image_cleanup_queue queue
      SET status = 'blocked',
          resolution_reason = 'storage_owner_mismatch',
          completed_at = _now,
          claim_token = NULL,
          claim_expires_at = NULL,
          storage_object_id = _storage_object_id,
          updated_at = _now
      WHERE queue.id = _queue.id;
      CONTINUE;
    END IF;

    _new_token := gen_random_uuid();
    UPDATE private.client_profile_image_cleanup_queue queue
    SET status = 'claimed',
        claimed_at = _now,
        claim_token = _new_token,
        claim_expires_at = _now + interval '5 minutes',
        storage_object_id = _storage_object_id,
        attempts = queue.attempts + 1,
        last_error_code = NULL,
        resolution_reason = NULL,
        completed_at = NULL,
        updated_at = _now
    WHERE queue.id = _queue.id;

    RETURN QUERY SELECT _queue.id, _queue.owner_user_id, _queue.bucket_id,
      _queue.object_path, _new_token;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.authorize_client_profile_image_cleanup_for_server(
  _queue_id UUID,
  _claim_token UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, storage, pg_temp
AS $$
DECLARE
  _queue private.client_profile_image_cleanup_queue%ROWTYPE;
  _storage_object_id UUID;
  _storage_owner_id TEXT;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT * INTO _queue
  FROM private.client_profile_image_cleanup_queue queue
  WHERE queue.id = _queue_id
  FOR UPDATE;
  IF NOT FOUND OR _queue.status <> 'claimed' OR _queue.claim_token IS DISTINCT FROM _claim_token
    OR _queue.claim_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'profile_image_cleanup_claim_not_found';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      _queue.owner_user_id::TEXT || '|' || _queue.bucket_id || '|' || _queue.object_path,
      0
    )
  );
  PERFORM 1 FROM public.client_profiles profile
    WHERE profile.user_id = _queue.owner_user_id FOR UPDATE;
  PERFORM 1 FROM public.profiles profile
    WHERE profile.user_id = _queue.owner_user_id FOR UPDATE;

  IF private.client_profile_image_is_referenced(_queue.owner_user_id, _queue.object_path) THEN
    UPDATE private.client_profile_image_cleanup_queue queue
    SET status = 'retained',
        resolution_reason = 'reference_restored_before_remove',
        completed_at = clock_timestamp(),
        claim_token = NULL,
        claim_expires_at = NULL,
        updated_at = clock_timestamp()
    WHERE queue.id = _queue.id;
    RETURN 'retained';
  END IF;

  SELECT object.id, object.owner_id
  INTO _storage_object_id, _storage_owner_id
  FROM storage.objects object
  WHERE object.bucket_id = _queue.bucket_id
    AND object.name = _queue.object_path;
  IF FOUND AND (
    _storage_object_id IS DISTINCT FROM _queue.storage_object_id
    OR _storage_owner_id IS DISTINCT FROM _queue.owner_user_id::TEXT
  ) THEN
    UPDATE private.client_profile_image_cleanup_queue queue
    SET status = 'blocked',
        resolution_reason = 'storage_identity_changed',
        completed_at = clock_timestamp(),
        claim_token = NULL,
        claim_expires_at = NULL,
        updated_at = clock_timestamp()
    WHERE queue.id = _queue.id;
    RETURN 'blocked';
  END IF;
  RETURN 'delete';
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_client_profile_image_cleanup_for_server(
  _queue_id UUID,
  _claim_token UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, storage, pg_temp
AS $$
DECLARE
  _queue private.client_profile_image_cleanup_queue%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT * INTO _queue
  FROM private.client_profile_image_cleanup_queue queue
  WHERE queue.id = _queue_id
  FOR UPDATE;
  IF NOT FOUND OR _queue.status <> 'claimed' OR _queue.claim_token IS DISTINCT FROM _claim_token THEN
    RAISE EXCEPTION 'profile_image_cleanup_claim_not_found';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      _queue.owner_user_id::TEXT || '|' || _queue.bucket_id || '|' || _queue.object_path,
      0
    )
  );
  PERFORM 1 FROM public.client_profiles profile
    WHERE profile.user_id = _queue.owner_user_id FOR UPDATE;
  PERFORM 1 FROM public.profiles profile
    WHERE profile.user_id = _queue.owner_user_id FOR UPDATE;

  IF private.client_profile_image_is_referenced(_queue.owner_user_id, _queue.object_path) THEN
    UPDATE private.client_profile_image_cleanup_queue queue
    SET status = 'blocked',
        resolution_reason = 'reference_changed_after_authorization',
        completed_at = clock_timestamp(),
        claim_token = NULL,
        claim_expires_at = NULL,
        updated_at = clock_timestamp()
    WHERE queue.id = _queue.id;
    RETURN 'blocked';
  END IF;
  IF EXISTS (
    SELECT 1 FROM storage.objects object
    WHERE object.bucket_id = _queue.bucket_id
      AND object.name = _queue.object_path
  ) THEN
    RAISE EXCEPTION 'profile_image_storage_object_still_present';
  END IF;

  UPDATE private.client_profile_image_cleanup_queue queue
  SET status = 'deleted',
      resolution_reason = 'storage_removal_verified',
      completed_at = clock_timestamp(),
      claim_token = NULL,
      claim_expires_at = NULL,
      storage_object_id = NULL,
      last_error_code = NULL,
      updated_at = clock_timestamp()
  WHERE queue.id = _queue.id;
  RETURN 'deleted';
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_client_profile_image_cleanup_for_server(
  _queue_id UUID,
  _claim_token UUID,
  _error_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _attempts INTEGER;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT queue.attempts INTO _attempts
  FROM private.client_profile_image_cleanup_queue queue
  WHERE queue.id = _queue_id
    AND queue.status = 'claimed'
    AND queue.claim_token = _claim_token
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile_image_cleanup_claim_not_found'; END IF;

  UPDATE private.client_profile_image_cleanup_queue queue
  SET status = CASE WHEN _attempts >= 8 THEN 'blocked' ELSE 'failed' END,
      next_attempt_at = CASE
        WHEN _attempts >= 8 THEN queue.next_attempt_at
        ELSE clock_timestamp() + make_interval(mins => LEAST(1440, 5 * (2 ^ LEAST(_attempts, 8))::INTEGER))
      END,
      last_error_code = left(COALESCE(NULLIF(btrim(_error_code), ''), 'cleanup_failed'), 120),
      resolution_reason = CASE WHEN _attempts >= 8 THEN 'retry_limit_reached' ELSE NULL END,
      completed_at = CASE WHEN _attempts >= 8 THEN clock_timestamp() ELSE NULL END,
      claim_token = NULL,
      claim_expires_at = NULL,
      updated_at = clock_timestamp()
  WHERE queue.id = _queue_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_expired_client_media_cleanup_for_server(_limit INTEGER DEFAULT 25)
RETURNS TABLE (upload_id UUID, bucket_id TEXT, source_path TEXT, preview_path TEXT, claim_token UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _claimed_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  UPDATE public.client_media_uploads upload
  SET status = 'cleanup_failed',
      cleanup_error_code = COALESCE(upload.cleanup_error_code, 'retry_limit_reached_after_lease_expiry'),
      cleanup_claimed_at = NULL,
      cleanup_claim_token = NULL,
      cleanup_claim_expires_at = NULL,
      next_cleanup_at = NULL,
      updated_at = _claimed_at
  WHERE upload.status = 'cleanup_in_progress'
    AND upload.cleanup_attempts >= 8
    AND upload.cleanup_claim_expires_at <= _claimed_at;

  RETURN QUERY
  WITH due AS (
    SELECT upload.id
    FROM public.client_media_uploads upload
    WHERE upload.cleanup_attempts < 8
      AND (
        (upload.status = 'pending_upload' AND upload.upload_expires_at <= _claimed_at)
        OR
        (upload.status = 'processing'
          AND upload.upload_expires_at <= _claimed_at
          AND upload.finalize_claim_expires_at <= _claimed_at)
        OR
        (upload.status = 'cleanup_pending'
          AND upload.finalized_at IS NOT NULL
          AND upload.access_expires_at <= _claimed_at
          AND upload.next_cleanup_at <= _claimed_at)
        OR
        (upload.status = 'cleanup_failed'
          AND upload.next_cleanup_at <= _claimed_at
          AND (
            (upload.finalized_at IS NULL AND upload.upload_expires_at <= _claimed_at)
            OR
            (upload.finalized_at IS NOT NULL AND upload.access_expires_at <= _claimed_at)
          ))
        OR
        (upload.status = 'cleanup_in_progress'
          AND upload.cleanup_claim_expires_at <= _claimed_at)
      )
    ORDER BY COALESCE(upload.next_cleanup_at, upload.cleanup_claim_expires_at, upload.upload_expires_at), upload.id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(_limit, 25), 1), 100)
  ), claimed AS (
    UPDATE public.client_media_uploads upload
    SET status = 'cleanup_in_progress', cleanup_claimed_at = _claimed_at,
        cleanup_claim_token = gen_random_uuid(),
        cleanup_claim_expires_at = _claimed_at + interval '5 minutes',
        cleanup_attempts = cleanup_attempts + 1, updated_at = _claimed_at
    FROM due WHERE upload.id = due.id
    RETURNING upload.id, upload.bucket_id, upload.source_path, upload.preview_path, upload.cleanup_claim_token
  )
  SELECT claimed.id, claimed.bucket_id, claimed.source_path, claimed.preview_path, claimed.cleanup_claim_token
  FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_client_media_cleanup_for_server(
  _upload_id UUID,
  _claim_token UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage, pg_temp
AS $$
DECLARE
  _upload public.client_media_uploads%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT * INTO _upload
  FROM public.client_media_uploads upload
  WHERE upload.id = _upload_id
    AND upload.status = 'cleanup_in_progress'
    AND upload.cleanup_claim_token = _claim_token
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'client_media_cleanup_claim_not_found'; END IF;
  IF EXISTS (
    SELECT 1 FROM storage.objects object
    WHERE object.bucket_id = _upload.bucket_id
      AND object.name IN (_upload.source_path, _upload.preview_path)
  ) THEN
    RAISE EXCEPTION 'client_media_storage_object_still_present';
  END IF;

  UPDATE public.client_media_uploads
  SET status = 'deleted', deleted_at = clock_timestamp(), cleanup_error_code = NULL,
      cleanup_claimed_at = NULL, cleanup_claim_token = NULL,
      cleanup_claim_expires_at = NULL, next_cleanup_at = NULL,
      updated_at = clock_timestamp()
  WHERE id = _upload_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_client_media_cleanup_for_server(
  _upload_id UUID,
  _claim_token UUID,
  _error_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _attempts INTEGER;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  SELECT upload.cleanup_attempts INTO _attempts
  FROM public.client_media_uploads upload
  WHERE upload.id = _upload_id
    AND upload.status = 'cleanup_in_progress'
    AND upload.cleanup_claim_token = _claim_token
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'client_media_cleanup_claim_not_found'; END IF;

  UPDATE public.client_media_uploads upload
  SET status = 'cleanup_failed',
      cleanup_error_code = left(COALESCE(NULLIF(btrim(_error_code), ''), 'cleanup_failed'), 120),
      cleanup_claimed_at = NULL,
      cleanup_claim_token = NULL,
      cleanup_claim_expires_at = NULL,
      next_cleanup_at = CASE
        WHEN _attempts >= 8 THEN NULL
        ELSE clock_timestamp() + make_interval(mins => LEAST(1440, 5 * (2 ^ LEAST(_attempts, 8))::INTEGER))
      END,
      updated_at = clock_timestamp()
  WHERE upload.id = _upload_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_media_cleanup_backlog_for_server()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'service_role_required'; END IF;
  RETURN jsonb_build_object(
    'client_due', (
      SELECT count(*) FROM public.client_media_uploads upload
      WHERE upload.cleanup_attempts < 8 AND (
        (upload.status = 'pending_upload' AND upload.upload_expires_at <= _now)
        OR (upload.status = 'processing' AND upload.upload_expires_at <= _now
          AND upload.finalize_claim_expires_at <= _now)
        OR (upload.status IN ('cleanup_pending', 'cleanup_failed')
          AND COALESCE(upload.access_expires_at, upload.upload_expires_at) <= _now
          AND upload.next_cleanup_at <= _now)
        OR (upload.status = 'cleanup_in_progress' AND upload.cleanup_claim_expires_at <= _now)
      )
    ),
    'client_retry_exhausted', (
      SELECT count(*) FROM public.client_media_uploads upload
      WHERE upload.status = 'cleanup_failed' AND upload.cleanup_attempts >= 8
    ),
    'profile_due', (
      SELECT count(*) FROM private.client_profile_image_cleanup_queue queue
      WHERE queue.attempts < 8 AND (
        (queue.status IN ('pending_reference_check', 'failed') AND queue.next_attempt_at <= _now)
        OR (queue.status = 'claimed' AND queue.claim_expires_at <= _now)
      )
    ),
    'profile_blocked', (
      SELECT count(*) FROM private.client_profile_image_cleanup_queue queue
      WHERE queue.status = 'blocked'
    ),
    'oldest_due_at', LEAST(
      (SELECT min(COALESCE(upload.next_cleanup_at, upload.cleanup_claim_expires_at, upload.upload_expires_at))
       FROM public.client_media_uploads upload
       WHERE upload.status IN ('pending_upload', 'processing', 'cleanup_pending', 'cleanup_failed', 'cleanup_in_progress')),
      (SELECT min(COALESCE(queue.next_attempt_at, queue.claim_expires_at))
       FROM private.client_profile_image_cleanup_queue queue
       WHERE queue.status IN ('pending_reference_check', 'failed', 'claimed'))
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION private.client_profile_image_is_referenced(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.guard_client_profile_image_cleanup_reference()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.guard_profile_avatar_cleanup_reference()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_client_profile_image_cleanup_for_server(INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.authorize_client_profile_image_cleanup_for_server(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_client_profile_image_cleanup_for_server(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_client_profile_image_cleanup_for_server(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_media_cleanup_backlog_for_server()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_client_profile_image_cleanup_for_server(INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.authorize_client_profile_image_cleanup_for_server(UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_client_profile_image_cleanup_for_server(UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_client_profile_image_cleanup_for_server(UUID, UUID, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_media_cleanup_backlog_for_server()
  TO service_role;

NOTIFY pgrst, 'reload schema';

-- V2-30: hard delete unused media through a server-only Storage workflow.

ALTER TABLE public.character_media_assets
  ADD COLUMN IF NOT EXISTS deletion_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_started_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION private.assert_admin_media_hard_delete_actor(_actor_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role'
    OR _actor_user_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.user_roles role
      WHERE role.user_id = _actor_user_id
        AND role.role = 'admin'::public.app_role
    ) THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_media_asset_hard_delete_unused(_asset_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.message_attachments attachment
    WHERE attachment.media_asset_id = _asset_id
  ) OR EXISTS (
    SELECT 1
    FROM public.character_media_reservations reservation
    WHERE reservation.media_asset_id = _asset_id
  ) THEN
    RAISE EXCEPTION 'media_asset_in_use';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_character_media_hard_delete_for_server(
  _actor_user_id UUID,
  _asset_id UUID
)
RETURNS TABLE (
  asset_id UUID,
  bucket_id TEXT,
  source_path TEXT,
  preview_path TEXT,
  locked_teaser_path TEXT,
  locked_delivery_path TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _asset public.character_media_assets%ROWTYPE;
BEGIN
  PERFORM private.assert_admin_media_hard_delete_actor(_actor_user_id);

  SELECT * INTO _asset
  FROM public.character_media_assets asset
  WHERE asset.id = _asset_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'media_asset_not_found';
  END IF;
  IF _asset.status IN ('reserved', 'sent') THEN
    RAISE EXCEPTION 'media_asset_in_use';
  END IF;

  PERFORM private.assert_media_asset_hard_delete_unused(_asset.id);

  IF _asset.deletion_started_at IS NULL THEN
    UPDATE public.character_media_assets
    SET status = 'disabled',
        disabled_at = COALESCE(disabled_at, clock_timestamp()),
        disabled_by_user_id = COALESCE(disabled_by_user_id, _actor_user_id),
        disabled_reason = COALESCE(disabled_reason, 'hard_delete_pending'),
        status_before_disabled = CASE
          WHEN status = 'disabled' THEN status_before_disabled
          ELSE status
        END,
        deletion_started_at = clock_timestamp(),
        deletion_started_by_user_id = _actor_user_id,
        updated_at = clock_timestamp(),
        updated_by_user_id = _actor_user_id
    WHERE id = _asset.id
    RETURNING * INTO _asset;
  END IF;

  RETURN QUERY
  SELECT
    _asset.id,
    _asset.bucket_id,
    _asset.source_path,
    _asset.preview_path,
    _asset.locked_teaser_path,
    _asset.locked_delivery_path;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_character_media_hard_delete_for_server(
  _actor_user_id UUID,
  _asset_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _asset public.character_media_assets%ROWTYPE;
  _paths TEXT[];
BEGIN
  PERFORM private.assert_admin_media_hard_delete_actor(_actor_user_id);

  SELECT * INTO _asset
  FROM public.character_media_assets asset
  WHERE asset.id = _asset_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', TRUE, 'already_deleted', TRUE);
  END IF;
  IF _asset.deletion_started_at IS NULL THEN
    RAISE EXCEPTION 'media_delete_not_started';
  END IF;

  PERFORM private.assert_media_asset_hard_delete_unused(_asset.id);

  _paths := array_remove(ARRAY[
    _asset.source_path,
    _asset.preview_path,
    _asset.locked_teaser_path,
    _asset.locked_delivery_path
  ], NULL);

  IF EXISTS (
    SELECT 1
    FROM storage.objects object
    WHERE object.bucket_id = _asset.bucket_id
      AND object.name = ANY (_paths)
  ) THEN
    RAISE EXCEPTION 'media_storage_delete_incomplete';
  END IF;

  DELETE FROM public.character_media_assets
  WHERE id = _asset.id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _actor_user_id,
    'character_media_asset.hard_deleted',
    'character_media_asset',
    _asset.id::TEXT,
    jsonb_build_object('character_id', _asset.character_id, 'storage_cleanup_confirmed', TRUE)
  );

  RETURN jsonb_build_object('deleted', TRUE, 'already_deleted', FALSE);
END;
$$;

REVOKE ALL ON FUNCTION private.assert_admin_media_hard_delete_actor(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_media_asset_hard_delete_unused(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_character_media_hard_delete_for_server(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_character_media_hard_delete_for_server(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.assert_admin_media_hard_delete_actor(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION private.assert_media_asset_hard_delete_unused(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_character_media_hard_delete_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_character_media_hard_delete_for_server(UUID, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';

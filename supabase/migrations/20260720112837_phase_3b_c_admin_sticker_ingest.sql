-- Phase 3B-C-A: Admin-only sticker ingest. Conversation behavior remains flag-gated.

ALTER TABLE public.stickers
  ALTER COLUMN width DROP NOT NULL,
  ALTER COLUMN height DROP NOT NULL,
  ALTER COLUMN byte_size DROP NOT NULL,
  ALTER COLUMN is_active SET DEFAULT false,
  ADD COLUMN ingest_status TEXT NOT NULL DEFAULT 'pending_upload'
    CHECK (ingest_status IN ('pending_upload', 'processing', 'ready', 'failed')),
  ADD COLUMN source_path TEXT,
  ADD COLUMN processing_started_at TIMESTAMPTZ,
  ADD COLUMN processed_at TIMESTAMPTZ,
  ADD COLUMN failed_at TIMESTAMPTZ,
  ADD COLUMN failure_code TEXT;

ALTER TABLE public.stickers
  ADD CONSTRAINT stickers_source_path_check CHECK (
    source_path IS NULL
    OR source_path ~ '^collections/[0-9a-f-]+/stickers/[0-9a-f-]+/source\\.webp$'
  ),
  ADD CONSTRAINT stickers_ready_state_check CHECK (
    is_active = false OR ingest_status = 'ready'
  ),
  ADD CONSTRAINT stickers_ready_metadata_check CHECK (
    ingest_status <> 'ready'
    OR (
      object_path IS NOT NULL
      AND width IS NOT NULL
      AND height IS NOT NULL
      AND byte_size IS NOT NULL
      AND processed_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT stickers_pending_metadata_check CHECK (
    ingest_status = 'ready'
    OR (width IS NULL AND height IS NULL AND byte_size IS NULL AND processed_at IS NULL)
  );

CREATE OR REPLACE FUNCTION private.assert_sticker_server_admin(_actor_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF _actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles r WHERE r.user_id = _actor_user_id AND r.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'admin_required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_sticker_upload_intent_for_server(
  _actor_user_id UUID,
  _collection_slug TEXT,
  _collection_name TEXT,
  _character_id UUID,
  _sticker_slug TEXT,
  _sticker_name TEXT
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
BEGIN
  PERFORM private.assert_sticker_server_admin(_actor_user_id);
  IF _collection_slug IS NULL OR _collection_slug !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    OR _sticker_slug IS NULL OR _sticker_slug !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
    OR char_length(btrim(coalesce(_collection_name, ''))) NOT BETWEEN 1 AND 100
    OR char_length(btrim(coalesce(_sticker_name, ''))) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_sticker_metadata';
  END IF;

  IF _character_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.characters c WHERE c.id = _character_id) THEN
    RAISE EXCEPTION 'character_not_found';
  END IF;

  SELECT * INTO _collection FROM public.sticker_collections sc
  WHERE sc.slug = _collection_slug
    AND sc.character_id IS NOT DISTINCT FROM _character_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.sticker_collections (slug, name, character_id, is_active, created_by_user_id, updated_by_user_id)
    VALUES (_collection_slug, btrim(_collection_name), _character_id, true, _actor_user_id, _actor_user_id)
    RETURNING * INTO _collection;
  END IF;

  _source_path := format('collections/%s/stickers/%s/source.webp', _collection.id, _id);
  INSERT INTO public.stickers (
    id, collection_id, slug, name, object_path, source_path, content_type, is_active, ingest_status,
    created_by_user_id, updated_by_user_id
  ) VALUES (
    _id, _collection.id, _sticker_slug, btrim(_sticker_name),
    format('collections/%s/stickers/%s/render.webp', _collection.id, _id),
    _source_path, 'image/webp', false, 'pending_upload', _actor_user_id, _actor_user_id
  );

  RETURN QUERY SELECT _id, _source_path;
END;
$$;

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
  SELECT * INTO _sticker FROM public.stickers s WHERE s.id = _sticker_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sticker_not_found'; END IF;
  IF _sticker.ingest_status = 'ready' THEN
    RETURN QUERY SELECT _sticker.id, NULL::TEXT, _sticker.object_path, true;
    RETURN;
  END IF;
  IF _sticker.ingest_status = 'processing' THEN RAISE EXCEPTION 'sticker_processing_in_progress'; END IF;
  IF _sticker.ingest_status = 'failed'
    AND coalesce(_sticker.failure_code, '') NOT IN ('storage_temporary_failure', 'render_temporary_failure', 'finalize_temporary_failure') THEN
    RAISE EXCEPTION 'sticker_upload_required';
  END IF;
  IF _sticker.source_path IS NULL THEN RAISE EXCEPTION 'sticker_upload_required'; END IF;

  UPDATE public.stickers s SET ingest_status = 'processing', processing_started_at = clock_timestamp(),
    failed_at = NULL, failure_code = NULL, updated_at = clock_timestamp(), updated_by_user_id = _actor_user_id
  WHERE s.id = _sticker.id;
  RETURN QUERY SELECT _sticker.id, _sticker.source_path, _sticker.object_path, false;
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
DECLARE _sticker public.stickers%ROWTYPE;
BEGIN
  PERFORM private.assert_sticker_server_admin(_actor_user_id);
  IF _width NOT BETWEEN 1 AND 4096 OR _height NOT BETWEEN 1 AND 4096 OR _byte_size NOT BETWEEN 1 AND 524288 THEN
    RAISE EXCEPTION 'invalid_sticker_dimensions';
  END IF;
  SELECT * INTO _sticker FROM public.stickers s WHERE s.id = _sticker_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sticker_not_found'; END IF;
  IF _sticker.ingest_status = 'ready' THEN
    RETURN QUERY SELECT _sticker.id, _sticker.ingest_status, true;
    RETURN;
  END IF;
  IF _sticker.ingest_status <> 'processing' THEN RAISE EXCEPTION 'sticker_processing_not_started'; END IF;
  UPDATE public.stickers s SET ingest_status = 'ready', width = _width, height = _height, byte_size = _byte_size,
    processed_at = clock_timestamp(), source_path = NULL, updated_at = clock_timestamp(), updated_by_user_id = _actor_user_id
  WHERE s.id = _sticker.id;
  RETURN QUERY SELECT _sticker.id, 'ready'::TEXT, false;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_sticker_processing_for_server(
  _actor_user_id UUID,
  _sticker_id UUID,
  _failure_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.assert_sticker_server_admin(_actor_user_id);
  UPDATE public.stickers s SET ingest_status = 'failed', is_active = false, failed_at = clock_timestamp(),
    failure_code = left(coalesce(_failure_code, 'sticker_processing_failed'), 100), processing_started_at = NULL,
    updated_at = clock_timestamp(), updated_by_user_id = _actor_user_id
  WHERE s.id = _sticker_id AND s.ingest_status = 'processing';
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_sticker_catalog()
RETURNS TABLE (
  id UUID, collection_id UUID, collection_name TEXT, collection_slug TEXT, character_id UUID,
  name TEXT, slug TEXT, is_active BOOLEAN, collection_is_active BOOLEAN, ingest_status TEXT,
  width INTEGER, height INTEGER, byte_size INTEGER, failure_code TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_required'; END IF;
  RETURN QUERY SELECT s.id, sc.id, sc.name, sc.slug, sc.character_id, s.name, s.slug, s.is_active, sc.is_active,
    s.ingest_status, s.width, s.height, s.byte_size, s.failure_code, s.created_at, s.updated_at
  FROM public.stickers s JOIN public.sticker_collections sc ON sc.id = s.collection_id
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
  UPDATE public.stickers s SET is_active = _is_active, updated_at = clock_timestamp(), updated_by_user_id = auth.uid()
  WHERE s.id = _sticker_id AND (NOT _is_active OR s.ingest_status = 'ready');
  IF NOT FOUND THEN RAISE EXCEPTION 'sticker_not_ready'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_admin_sticker_object_path_for_server(_actor_user_id UUID, _sticker_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _object_path TEXT;
BEGIN
  PERFORM private.assert_sticker_server_admin(_actor_user_id);
  SELECT s.object_path INTO _object_path FROM public.stickers s
  WHERE s.id = _sticker_id AND s.ingest_status = 'ready';
  RETURN _object_path;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_conversation_stickers(_conversation_id UUID)
RETURNS TABLE (sticker_id UUID, collection_id UUID, name TEXT, collection_name TEXT, scope TEXT, sort_order INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE _user_id UUID := auth.uid(); _conversation public.conversations%ROWTYPE; _operator_id UUID;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF private.setting_bool('stickers_enabled', false) IS NOT TRUE THEN RAISE EXCEPTION 'stickers_disabled'; END IF;
  SELECT * INTO _conversation FROM public.conversations c WHERE c.id = _conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  IF _conversation.status = 'closed'::public.conversation_status THEN RAISE EXCEPTION 'conversation_closed'; END IF;
  IF _conversation.client_id = _user_id THEN
    PERFORM private.ensure_active_client(_user_id);
    IF _conversation.client_hidden_at IS NOT NULL OR EXISTS (SELECT 1 FROM public.client_conversation_deletions d WHERE d.client_id = _user_id AND d.conversation_id = _conversation_id) THEN RAISE EXCEPTION 'conversation_deleted_for_client'; END IF;
  ELSE
    SELECT o.id INTO _operator_id FROM public.operators o WHERE o.user_id = _user_id AND o.is_active = true LIMIT 1;
    IF _operator_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.character_operator_assignments coa WHERE coa.character_id = _conversation.character_id AND coa.operator_id = _operator_id) THEN RAISE EXCEPTION 'conversation_access_denied'; END IF;
  END IF;
  RETURN QUERY SELECT s.id, sc.id, s.name, sc.name, CASE WHEN sc.character_id IS NULL THEN 'global' ELSE 'character' END, s.sort_order
  FROM public.stickers s JOIN public.sticker_collections sc ON sc.id = s.collection_id
  WHERE s.is_active = true AND s.ingest_status = 'ready' AND sc.is_active = true
    AND (sc.character_id IS NULL OR sc.character_id = _conversation.character_id)
  ORDER BY sc.sort_order, sc.name, s.sort_order, s.name, s.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_sticker_object_path_for_server(_actor_user_id UUID, _message_sticker_id UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE _object_path TEXT;
BEGIN
  IF _actor_user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF private.setting_bool('stickers_enabled', false) IS NOT TRUE THEN RETURN NULL; END IF;
  SELECT s.object_path INTO _object_path FROM public.message_stickers ms
  JOIN public.messages m ON m.id = ms.message_id JOIN public.conversations c ON c.id = m.conversation_id
  JOIN public.stickers s ON s.id = ms.sticker_id JOIN public.sticker_collections sc ON sc.id = s.collection_id
  WHERE ms.id = _message_sticker_id AND s.is_active = true AND s.ingest_status = 'ready' AND sc.is_active = true
    AND (c.client_id = _actor_user_id OR EXISTS (
      SELECT 1 FROM public.user_roles r WHERE r.user_id = _actor_user_id AND r.role = 'admin'
    ) OR EXISTS (
      SELECT 1 FROM public.operators o JOIN public.character_operator_assignments coa ON coa.operator_id = o.id
      WHERE o.user_id = _actor_user_id AND o.is_active = true AND coa.character_id = c.character_id));
  RETURN _object_path;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_conversation_sticker_object_path_for_server(_actor_user_id UUID, _conversation_id UUID, _sticker_id UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE _conversation public.conversations%ROWTYPE; _operator_id UUID; _object_path TEXT;
BEGIN
  IF _actor_user_id IS NULL OR _conversation_id IS NULL OR _sticker_id IS NULL THEN RETURN NULL; END IF;
  IF private.setting_bool('stickers_enabled', false) IS NOT TRUE THEN RETURN NULL; END IF;
  SELECT * INTO _conversation FROM public.conversations c WHERE c.id = _conversation_id;
  IF NOT FOUND OR _conversation.status = 'closed'::public.conversation_status THEN RETURN NULL; END IF;
  IF _conversation.client_id = _actor_user_id THEN
    PERFORM private.ensure_active_client(_actor_user_id);
    IF _conversation.client_hidden_at IS NOT NULL OR EXISTS (SELECT 1 FROM public.client_conversation_deletions d WHERE d.client_id = _actor_user_id AND d.conversation_id = _conversation_id) THEN RETURN NULL; END IF;
  ELSE
    SELECT o.id INTO _operator_id FROM public.operators o WHERE o.user_id = _actor_user_id AND o.is_active = true LIMIT 1;
    IF _operator_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.character_operator_assignments coa WHERE coa.character_id = _conversation.character_id AND coa.operator_id = _operator_id) THEN RETURN NULL; END IF;
  END IF;
  SELECT s.object_path INTO _object_path FROM public.stickers s JOIN public.sticker_collections sc ON sc.id = s.collection_id
  WHERE s.id = _sticker_id AND s.bucket_id = 'sticker-media' AND s.is_active = true AND s.ingest_status = 'ready' AND sc.is_active = true
    AND (sc.character_id IS NULL OR sc.character_id = _conversation.character_id);
  RETURN _object_path;
END;
$$;

-- Sending stays flag-gated. This trigger is a final integrity guard for direct/internal send paths.
CREATE OR REPLACE FUNCTION private.assert_message_sticker_marker()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE _message public.messages%ROWTYPE;
BEGIN
  SELECT * INTO _message FROM public.messages WHERE id = NEW.message_id;
  IF NOT FOUND OR _message.content <> '[sticker]' OR _message.sender_type NOT IN ('client'::public.sender_type, 'operator'::public.sender_type)
    OR NOT EXISTS (
      SELECT 1 FROM public.stickers s JOIN public.sticker_collections sc ON sc.id = s.collection_id
      WHERE s.id = NEW.sticker_id AND s.is_active = true AND s.ingest_status = 'ready' AND sc.is_active = true
    ) THEN RAISE EXCEPTION 'invalid_sticker_message_marker'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.send_sticker_message(
  _conversation_id UUID,
  _sticker_id UUID,
  _idempotency_key UUID,
  _actor_kind TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid(); _operator_guard RECORD; _client_guard RECORD; _sticker RECORD;
  _attempt private.sticker_send_attempts%ROWTYPE; _message public.messages%ROWTYPE;
  _message_sticker public.message_stickers%ROWTYPE; _conversation_character_id UUID;
  _fingerprint TEXT := format('sticker:%s:%s:%s', _actor_kind, _conversation_id, _sticker_id);
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF _idempotency_key IS NULL THEN RAISE EXCEPTION 'sticker_idempotency_key_required'; END IF;
  IF _actor_kind = 'client' THEN
    SELECT * INTO _client_guard FROM private.assert_client_can_send_sticker_message(_conversation_id);
  ELSIF _actor_kind = 'operator' THEN
    SELECT * INTO _operator_guard FROM private.assert_operator_can_send_conversation_message(_conversation_id);
  ELSE RAISE EXCEPTION 'invalid_sticker_sender'; END IF;

  SELECT c.character_id INTO _conversation_character_id FROM public.conversations c WHERE c.id = _conversation_id;
  SELECT * INTO _attempt FROM private.sticker_send_attempts a
  WHERE a.actor_user_id = _user_id AND a.idempotency_key = _idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF _attempt.request_fingerprint <> _fingerprint THEN RAISE EXCEPTION 'sticker_idempotency_key_reused'; END IF;
    IF _attempt.status <> 'succeeded' THEN RAISE EXCEPTION 'sticker_send_in_progress'; END IF;
    SELECT * INTO _message FROM public.messages m WHERE m.id = _attempt.message_id;
    SELECT * INTO _message_sticker FROM public.message_stickers ms WHERE ms.message_id = _attempt.message_id;
    RETURN jsonb_build_object('message', to_jsonb(_message), 'message_sticker', jsonb_build_object(
      'id', _message_sticker.id, 'message_id', _message_sticker.message_id, 'sticker_id', _message_sticker.sticker_id,
      'sticker_name_snapshot', _message_sticker.sticker_name_snapshot, 'collection_name_snapshot', _message_sticker.collection_name_snapshot,
      'created_at', _message_sticker.created_at), 'already_sent', true);
  END IF;

  IF private.setting_bool('stickers_enabled', false) IS NOT TRUE THEN RAISE EXCEPTION 'stickers_disabled'; END IF;
  SELECT s.id, s.name AS sticker_name, sc.name AS collection_name INTO _sticker
  FROM public.stickers s JOIN public.sticker_collections sc ON sc.id = s.collection_id
  WHERE s.id = _sticker_id AND s.is_active = true AND s.ingest_status = 'ready' AND sc.is_active = true
    AND (sc.character_id IS NULL OR sc.character_id = _conversation_character_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'sticker_not_available'; END IF;

  INSERT INTO private.sticker_send_attempts (actor_user_id, actor_kind, conversation_id, sticker_id, idempotency_key, request_fingerprint)
  VALUES (_user_id, _actor_kind, _conversation_id, _sticker_id, _idempotency_key, _fingerprint)
  ON CONFLICT (actor_user_id, idempotency_key) DO NOTHING RETURNING * INTO _attempt;
  IF NOT FOUND THEN
    SELECT * INTO _attempt FROM private.sticker_send_attempts a
    WHERE a.actor_user_id = _user_id AND a.idempotency_key = _idempotency_key FOR UPDATE;
    IF _attempt.request_fingerprint <> _fingerprint THEN RAISE EXCEPTION 'sticker_idempotency_key_reused'; END IF;
    IF _attempt.status <> 'succeeded' THEN RAISE EXCEPTION 'sticker_send_in_progress'; END IF;
    SELECT * INTO _message FROM public.messages m WHERE m.id = _attempt.message_id;
    SELECT * INTO _message_sticker FROM public.message_stickers ms WHERE ms.message_id = _attempt.message_id;
    RETURN jsonb_build_object('message', to_jsonb(_message), 'message_sticker', jsonb_build_object(
      'id', _message_sticker.id, 'message_id', _message_sticker.message_id, 'sticker_id', _message_sticker.sticker_id,
      'sticker_name_snapshot', _message_sticker.sticker_name_snapshot, 'collection_name_snapshot', _message_sticker.collection_name_snapshot,
      'created_at', _message_sticker.created_at), 'already_sent', true);
  END IF;

  PERFORM private.consume_sticker_send_rate_limit(_conversation_id, _user_id, _actor_kind);
  INSERT INTO public.messages (conversation_id, sender_type, sender_id, operator_id, content, created_at)
  VALUES (_conversation_id, _actor_kind::public.sender_type, _user_id,
    CASE WHEN _actor_kind = 'operator' THEN _operator_guard.operator_id ELSE NULL END, '[sticker]', clock_timestamp())
  RETURNING * INTO _message;
  INSERT INTO public.message_stickers (message_id, sticker_id, sticker_name_snapshot, collection_name_snapshot)
  VALUES (_message.id, _sticker.id, _sticker.sticker_name, _sticker.collection_name) RETURNING * INTO _message_sticker;
  UPDATE private.sticker_send_attempts SET message_id = _message.id, status = 'succeeded', updated_at = clock_timestamp()
  WHERE id = _attempt.id;
  RETURN jsonb_build_object('message', to_jsonb(_message), 'message_sticker', jsonb_build_object(
    'id', _message_sticker.id, 'message_id', _message_sticker.message_id, 'sticker_id', _message_sticker.sticker_id,
    'sticker_name_snapshot', _message_sticker.sticker_name_snapshot, 'collection_name_snapshot', _message_sticker.collection_name_snapshot,
    'created_at', _message_sticker.created_at), 'already_sent', false);
END;
$$;

REVOKE ALL ON FUNCTION private.assert_sticker_server_admin(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_sticker_upload_intent_for_server(UUID, TEXT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.begin_sticker_processing_for_server(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_sticker_processing_for_server(UUID, UUID, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_sticker_processing_for_server(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_admin_sticker_object_path_for_server(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_sticker_upload_intent_for_server(UUID, TEXT, TEXT, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_sticker_processing_for_server(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_sticker_processing_for_server(UUID, UUID, INTEGER, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_sticker_processing_for_server(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_admin_sticker_object_path_for_server(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.get_admin_sticker_catalog() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_sticker_active(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_sticker_catalog() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_sticker_active(UUID, BOOLEAN) TO authenticated;

NOTIFY pgrst, 'reload schema';

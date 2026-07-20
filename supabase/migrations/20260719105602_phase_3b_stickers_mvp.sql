-- Phase 3B-A: free sticker DB foundation. The feature flag stays disabled.

INSERT INTO public.system_settings (key, value)
VALUES ('stickers_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('sticker-media', 'sticker-media', false, 524288, ARRAY['image/webp'])
ON CONFLICT (id) DO NOTHING;

CREATE TABLE public.sticker_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  character_id UUID REFERENCES public.characters(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX sticker_collections_global_slug_key
  ON public.sticker_collections (slug)
  WHERE character_id IS NULL;

CREATE UNIQUE INDEX sticker_collections_character_slug_key
  ON public.sticker_collections (character_id, slug)
  WHERE character_id IS NOT NULL;

CREATE INDEX sticker_collections_active_catalog_idx
  ON public.sticker_collections (character_id, sort_order, name)
  WHERE is_active;

CREATE TABLE public.stickers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES public.sticker_collections(id) ON DELETE CASCADE,
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  bucket_id TEXT NOT NULL DEFAULT 'sticker-media' CHECK (bucket_id = 'sticker-media'),
  object_path TEXT NOT NULL CHECK (
    object_path ~ '^collections/[0-9a-f-]+/stickers/[0-9a-f-]+/render\\.webp$'
  ),
  content_type TEXT NOT NULL DEFAULT 'image/webp' CHECK (content_type = 'image/webp'),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 4096),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 4096),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 524288),
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (collection_id, slug),
  UNIQUE (bucket_id, object_path)
);

CREATE INDEX stickers_active_catalog_idx
  ON public.stickers (collection_id, sort_order, name)
  WHERE is_active;

CREATE TABLE public.message_stickers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
  sticker_id UUID NOT NULL REFERENCES public.stickers(id) ON DELETE RESTRICT,
  sticker_name_snapshot TEXT NOT NULL CHECK (char_length(btrim(sticker_name_snapshot)) BETWEEN 1 AND 100),
  collection_name_snapshot TEXT NOT NULL CHECK (char_length(btrim(collection_name_snapshot)) BETWEEN 1 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX message_stickers_sticker_id_idx ON public.message_stickers (sticker_id);

CREATE TABLE private.sticker_send_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('client', 'operator')),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sticker_id UUID NOT NULL REFERENCES public.stickers(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (char_length(request_fingerprint) BETWEEN 1 AND 512),
  message_id UUID UNIQUE REFERENCES public.messages(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'succeeded', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT sticker_send_attempts_message_status_check CHECK (
    (status = 'succeeded' AND message_id IS NOT NULL)
    OR (status <> 'succeeded' AND message_id IS NULL)
  ),
  UNIQUE (actor_user_id, idempotency_key)
);

CREATE INDEX sticker_send_attempts_conversation_created_idx
  ON private.sticker_send_attempts (conversation_id, created_at DESC);

CREATE TABLE private.conversation_sticker_rate_limits (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('client', 'operator')),
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (conversation_id, actor_user_id, actor_kind)
);

ALTER TABLE public.sticker_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stickers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_stickers ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.sticker_send_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.conversation_sticker_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sticker_collections FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.stickers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.message_stickers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE private.sticker_send_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE private.conversation_sticker_rate_limits FROM PUBLIC, anon, authenticated;

GRANT SELECT (id, message_id, sticker_id, sticker_name_snapshot, collection_name_snapshot, created_at)
  ON public.message_stickers TO authenticated;

CREATE POLICY "Authorized users can read message stickers"
  ON public.message_stickers
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = message_stickers.message_id
        AND (
          c.client_id = (SELECT auth.uid())
          OR public.is_admin()
          OR EXISTS (
            SELECT 1
            FROM public.operators o
            JOIN public.character_operator_assignments coa ON coa.operator_id = o.id
            WHERE o.user_id = (SELECT auth.uid())
              AND o.is_active = true
              AND coa.character_id = c.character_id
          )
        )
    )
  );

DROP POLICY IF EXISTS "Sticker media is server-only" ON storage.objects;
CREATE POLICY "Sticker media is server-only"
  ON storage.objects
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (bucket_id <> 'sticker-media')
  WITH CHECK (bucket_id <> 'sticker-media');

CREATE OR REPLACE FUNCTION private.assert_client_can_send_sticker_message(
  _conversation_id UUID
)
RETURNS TABLE (
  user_id UUID,
  character_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _conversation public.conversations%ROWTYPE;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM private.ensure_active_client(_user_id);

  SELECT *
  INTO _conversation
  FROM public.conversations c
  WHERE c.id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF _conversation.client_id <> _user_id THEN
    RAISE EXCEPTION 'conversation_access_denied';
  END IF;

  IF _conversation.status = 'closed'::public.conversation_status THEN
    RAISE EXCEPTION 'conversation_closed';
  END IF;

  IF _conversation.client_hidden_at IS NOT NULL OR EXISTS (
    SELECT 1
    FROM public.client_conversation_deletions d
    WHERE d.client_id = _user_id
      AND d.conversation_id = _conversation_id
  ) THEN
    RAISE EXCEPTION 'conversation_deleted_for_client';
  END IF;

  RETURN QUERY SELECT _user_id, _conversation.character_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.consume_sticker_send_rate_limit(
  _conversation_id UUID,
  _actor_user_id UUID,
  _actor_kind TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _accepted_at TIMESTAMPTZ;
BEGIN
  INSERT INTO private.conversation_sticker_rate_limits (
    conversation_id,
    actor_user_id,
    actor_kind,
    last_sent_at
  )
  VALUES (_conversation_id, _actor_user_id, _actor_kind, clock_timestamp())
  ON CONFLICT (conversation_id, actor_user_id, actor_kind) DO UPDATE
  SET last_sent_at = EXCLUDED.last_sent_at
  WHERE private.conversation_sticker_rate_limits.last_sent_at <= clock_timestamp() - INTERVAL '2 seconds'
  RETURNING last_sent_at INTO _accepted_at;

  IF _accepted_at IS NULL THEN
    RAISE EXCEPTION 'sticker_rate_limited';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_message_sticker_marker()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _message public.messages%ROWTYPE;
BEGIN
  SELECT * INTO _message
  FROM public.messages
  WHERE id = NEW.message_id;

  IF NOT FOUND OR _message.content <> '[sticker]'
    OR _message.sender_type NOT IN ('client'::public.sender_type, 'operator'::public.sender_type) THEN
    RAISE EXCEPTION 'invalid_sticker_message_marker';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER message_stickers_require_marker
  BEFORE INSERT OR UPDATE OF message_id ON public.message_stickers
  FOR EACH ROW
  EXECUTE FUNCTION private.assert_message_sticker_marker();

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
  _user_id UUID := auth.uid();
  _operator_guard RECORD;
  _client_guard RECORD;
  _sticker RECORD;
  _attempt private.sticker_send_attempts%ROWTYPE;
  _message public.messages%ROWTYPE;
  _message_sticker public.message_stickers%ROWTYPE;
  _conversation_character_id UUID;
  _fingerprint TEXT := format('sticker:%s:%s:%s', _actor_kind, _conversation_id, _sticker_id);
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF _idempotency_key IS NULL THEN
    RAISE EXCEPTION 'sticker_idempotency_key_required';
  END IF;

  IF _actor_kind = 'client' THEN
    SELECT * INTO _client_guard
    FROM private.assert_client_can_send_sticker_message(_conversation_id);
  ELSIF _actor_kind = 'operator' THEN
    SELECT * INTO _operator_guard
    FROM private.assert_operator_can_send_conversation_message(_conversation_id);
  ELSE
    RAISE EXCEPTION 'invalid_sticker_sender';
  END IF;

  SELECT c.character_id
  INTO _conversation_character_id
  FROM public.conversations c
  WHERE c.id = _conversation_id;

  SELECT * INTO _attempt
  FROM private.sticker_send_attempts a
  WHERE a.actor_user_id = _user_id
    AND a.idempotency_key = _idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF _attempt.request_fingerprint <> _fingerprint THEN
      RAISE EXCEPTION 'sticker_idempotency_key_reused';
    END IF;

    IF _attempt.status = 'succeeded' THEN
      SELECT * INTO _message
      FROM public.messages m
      WHERE m.id = _attempt.message_id;

      SELECT * INTO _message_sticker
      FROM public.message_stickers ms
      WHERE ms.message_id = _attempt.message_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'sticker_attempt_missing_message_sticker';
      END IF;

      RETURN jsonb_build_object(
        'message', to_jsonb(_message),
        'message_sticker', jsonb_build_object(
          'id', _message_sticker.id,
          'message_id', _message_sticker.message_id,
          'sticker_id', _message_sticker.sticker_id,
          'sticker_name_snapshot', _message_sticker.sticker_name_snapshot,
          'collection_name_snapshot', _message_sticker.collection_name_snapshot,
          'created_at', _message_sticker.created_at
        ),
        'already_sent', true
      );
    END IF;

    RAISE EXCEPTION 'sticker_send_in_progress';
  END IF;

  IF private.setting_bool('stickers_enabled', false) IS NOT TRUE THEN
    RAISE EXCEPTION 'stickers_disabled';
  END IF;

  SELECT
    s.id,
    s.name AS sticker_name,
    sc.name AS collection_name
  INTO _sticker
  FROM public.stickers s
  JOIN public.sticker_collections sc ON sc.id = s.collection_id
  WHERE s.id = _sticker_id
    AND s.is_active = true
    AND sc.is_active = true
    AND (sc.character_id IS NULL OR sc.character_id = _conversation_character_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sticker_not_available';
  END IF;

  INSERT INTO private.sticker_send_attempts (
    actor_user_id,
    actor_kind,
    conversation_id,
    sticker_id,
    idempotency_key,
    request_fingerprint
  )
  VALUES (
    _user_id,
    _actor_kind,
    _conversation_id,
    _sticker_id,
    _idempotency_key,
    _fingerprint
  )
  ON CONFLICT (actor_user_id, idempotency_key) DO NOTHING
  RETURNING * INTO _attempt;

  IF NOT FOUND THEN
    SELECT * INTO _attempt
    FROM private.sticker_send_attempts a
    WHERE a.actor_user_id = _user_id
      AND a.idempotency_key = _idempotency_key
    FOR UPDATE;

    IF _attempt.request_fingerprint <> _fingerprint THEN
      RAISE EXCEPTION 'sticker_idempotency_key_reused';
    END IF;

    IF _attempt.status = 'succeeded' THEN
      SELECT * INTO _message FROM public.messages m WHERE m.id = _attempt.message_id;
      SELECT * INTO _message_sticker FROM public.message_stickers ms WHERE ms.message_id = _attempt.message_id;
      RETURN jsonb_build_object(
        'message', to_jsonb(_message),
        'message_sticker', jsonb_build_object(
          'id', _message_sticker.id,
          'message_id', _message_sticker.message_id,
          'sticker_id', _message_sticker.sticker_id,
          'sticker_name_snapshot', _message_sticker.sticker_name_snapshot,
          'collection_name_snapshot', _message_sticker.collection_name_snapshot,
          'created_at', _message_sticker.created_at
        ),
        'already_sent', true
      );
    END IF;

    RAISE EXCEPTION 'sticker_send_in_progress';
  END IF;

  PERFORM private.consume_sticker_send_rate_limit(_conversation_id, _user_id, _actor_kind);

  INSERT INTO public.messages (
    conversation_id,
    sender_type,
    sender_id,
    operator_id,
    content,
    created_at
  )
  VALUES (
    _conversation_id,
    _actor_kind::public.sender_type,
    _user_id,
    CASE WHEN _actor_kind = 'operator' THEN _operator_guard.operator_id ELSE NULL END,
    '[sticker]',
    clock_timestamp()
  )
  RETURNING * INTO _message;

  INSERT INTO public.message_stickers (
    message_id,
    sticker_id,
    sticker_name_snapshot,
    collection_name_snapshot
  )
  VALUES (
    _message.id,
    _sticker.id,
    _sticker.sticker_name,
    _sticker.collection_name
  )
  RETURNING * INTO _message_sticker;

  UPDATE private.sticker_send_attempts
  SET
    message_id = _message.id,
    status = 'succeeded',
    updated_at = clock_timestamp()
  WHERE id = _attempt.id;

  RETURN jsonb_build_object(
    'message', to_jsonb(_message),
    'message_sticker', jsonb_build_object(
      'id', _message_sticker.id,
      'message_id', _message_sticker.message_id,
      'sticker_id', _message_sticker.sticker_id,
      'sticker_name_snapshot', _message_sticker.sticker_name_snapshot,
      'collection_name_snapshot', _message_sticker.collection_name_snapshot,
      'created_at', _message_sticker.created_at
    ),
    'already_sent', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_conversation_stickers(
  _conversation_id UUID
)
RETURNS TABLE (
  sticker_id UUID,
  collection_id UUID,
  name TEXT,
  collection_name TEXT,
  scope TEXT,
  sort_order INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _conversation public.conversations%ROWTYPE;
  _operator_id UUID;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF private.setting_bool('stickers_enabled', false) IS NOT TRUE THEN
    RAISE EXCEPTION 'stickers_disabled';
  END IF;

  SELECT * INTO _conversation
  FROM public.conversations c
  WHERE c.id = _conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF _conversation.status = 'closed'::public.conversation_status THEN
    RAISE EXCEPTION 'conversation_closed';
  END IF;

  IF _conversation.client_id = _user_id THEN
    PERFORM private.ensure_active_client(_user_id);
    IF _conversation.client_hidden_at IS NOT NULL OR EXISTS (
      SELECT 1 FROM public.client_conversation_deletions d
      WHERE d.client_id = _user_id AND d.conversation_id = _conversation_id
    ) THEN
      RAISE EXCEPTION 'conversation_deleted_for_client';
    END IF;
  ELSE
    SELECT o.id INTO _operator_id
    FROM public.operators o
    WHERE o.user_id = _user_id AND o.is_active = true
    LIMIT 1;

    IF _operator_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.character_operator_assignments coa
      WHERE coa.character_id = _conversation.character_id
        AND coa.operator_id = _operator_id
    ) THEN
      RAISE EXCEPTION 'conversation_access_denied';
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    s.id,
    sc.id,
    s.name,
    sc.name,
    CASE WHEN sc.character_id IS NULL THEN 'global' ELSE 'character' END,
    s.sort_order
  FROM public.stickers s
  JOIN public.sticker_collections sc ON sc.id = s.collection_id
  WHERE s.is_active = true
    AND sc.is_active = true
    AND (sc.character_id IS NULL OR sc.character_id = _conversation.character_id)
  ORDER BY sc.sort_order, sc.name, s.sort_order, s.name, s.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.send_client_sticker_message(
  _conversation_id UUID,
  _sticker_id UUID,
  _idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT private.send_sticker_message(_conversation_id, _sticker_id, _idempotency_key, 'client');
$$;

CREATE OR REPLACE FUNCTION public.send_operator_sticker_message(
  _conversation_id UUID,
  _sticker_id UUID,
  _idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT private.send_sticker_message(_conversation_id, _sticker_id, _idempotency_key, 'operator');
$$;

CREATE OR REPLACE FUNCTION public.resolve_sticker_object_path_for_server(
  _actor_user_id UUID,
  _message_sticker_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _object_path TEXT;
BEGIN
  IF _actor_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF private.setting_bool('stickers_enabled', false) IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  SELECT s.object_path
  INTO _object_path
  FROM public.message_stickers ms
  JOIN public.messages m ON m.id = ms.message_id
  JOIN public.conversations c ON c.id = m.conversation_id
  JOIN public.stickers s ON s.id = ms.sticker_id
  WHERE ms.id = _message_sticker_id
    AND (
      c.client_id = _actor_user_id
      OR EXISTS (
        SELECT 1
        FROM public.user_roles role
        WHERE role.user_id = _actor_user_id
          AND role.role = 'admin'
      )
      OR EXISTS (
        SELECT 1
        FROM public.operators o
        JOIN public.character_operator_assignments coa ON coa.operator_id = o.id
        WHERE o.user_id = _actor_user_id
          AND o.is_active = true
          AND coa.character_id = c.character_id
      )
    );

  RETURN _object_path;
END;
$$;

REVOKE ALL ON FUNCTION private.assert_client_can_send_sticker_message(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.consume_sticker_send_rate_limit(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_message_sticker_marker() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.send_sticker_message(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_sticker_object_path_for_server(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_conversation_stickers(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_client_sticker_message(UUID, UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.send_operator_sticker_message(UUID, UUID, UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_conversation_stickers(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_client_sticker_message(UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_operator_sticker_message(UUID, UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_sticker_object_path_for_server(UUID, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';

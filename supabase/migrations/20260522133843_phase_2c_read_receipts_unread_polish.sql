-- Phase 2C: Read receipts / unread polish.
-- conversation_read_states is the source of truth for personal unread state.

CREATE INDEX IF NOT EXISTS idx_messages_conversation_sender_created
  ON public.messages(conversation_id, sender_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_read_states_conversation_user
  ON public.conversation_read_states(conversation_id, user_id);

DO $$
BEGIN
  ALTER TABLE public.conversation_read_states REPLICA IDENTITY FULL;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'conversation_read_states'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_read_states;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.mark_conversation_read(_conversation_id UUID, _as TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _latest_message_id UUID;
  _latest_message_created_at TIMESTAMPTZ;
  _can_read BOOLEAN := false;
BEGIN
  IF _user_id IS NULL THEN
    RETURN;
  END IF;

  IF _as = 'client' THEN
    _can_read := public.is_conversation_client(_conversation_id);
  ELSIF _as IN ('operator', 'admin') THEN
    _can_read := public.is_conversation_operator(_conversation_id) OR public.is_admin();
  END IF;

  IF NOT _can_read THEN
    RETURN;
  END IF;

  SELECT id, created_at
  INTO _latest_message_id, _latest_message_created_at
  FROM public.messages
  WHERE conversation_id = _conversation_id
  ORDER BY created_at DESC
  LIMIT 1;

  INSERT INTO public.conversation_read_states (
    conversation_id,
    user_id,
    last_read_message_id,
    last_read_at
  )
  VALUES (
    _conversation_id,
    _user_id,
    _latest_message_id,
    COALESCE(_latest_message_created_at, clock_timestamp())
  )
  ON CONFLICT (conversation_id, user_id)
  DO UPDATE SET
    last_read_message_id = EXCLUDED.last_read_message_id,
    last_read_at = GREATEST(public.conversation_read_states.last_read_at, EXCLUDED.last_read_at);

  IF _as = 'client' THEN
    UPDATE public.conversations
    SET client_unread_count = 0
    WHERE id = _conversation_id;

    UPDATE public.messages
    SET is_read = true
    WHERE conversation_id = _conversation_id
      AND sender_type <> 'client'::public.sender_type;
  ELSIF _as IN ('operator', 'admin') THEN
    -- Do not reset operator_unread_count here. In shared inbox it is legacy/global
    -- metadata, while per-operator unread comes from conversation_read_states.
    UPDATE public.messages
    SET is_read = true
    WHERE conversation_id = _conversation_id
      AND sender_type = 'client'::public.sender_type;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_conversation_unread_counts(_conversation_ids UUID[])
RETURNS TABLE (
  conversation_id UUID,
  unread_count INTEGER,
  last_read_at TIMESTAMPTZ
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH requested AS (
    SELECT DISTINCT unnest(COALESCE(_conversation_ids, ARRAY[]::UUID[])) AS conversation_id
  ),
  allowed AS (
    SELECT
      r.conversation_id,
      CASE
        WHEN public.is_conversation_client(r.conversation_id) THEN 'client'
        WHEN public.is_conversation_operator(r.conversation_id) OR public.is_admin() THEN 'operator'
        ELSE NULL
      END AS viewer_side
    FROM requested r
  ),
  readable AS (
    SELECT
      a.conversation_id,
      a.viewer_side,
      crs.last_read_at
    FROM allowed a
    LEFT JOIN public.conversation_read_states crs
      ON crs.conversation_id = a.conversation_id
     AND crs.user_id = auth.uid()
    WHERE a.viewer_side IS NOT NULL
  )
  SELECT
    r.conversation_id,
    COUNT(m.id)::INTEGER AS unread_count,
    r.last_read_at
  FROM readable r
  LEFT JOIN public.messages m
    ON m.conversation_id = r.conversation_id
   AND m.created_at > COALESCE(r.last_read_at, '-infinity'::TIMESTAMPTZ)
   AND (
     (r.viewer_side = 'client' AND m.sender_type <> 'client'::public.sender_type)
     OR
     (r.viewer_side = 'operator' AND m.sender_type = 'client'::public.sender_type)
   )
  GROUP BY r.conversation_id, r.last_read_at;
$$;

CREATE OR REPLACE FUNCTION public.get_conversation_read_summary(_conversation_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _client_id UUID;
  _client_last_read_at TIMESTAMPTZ;
  _operator_last_read_at TIMESTAMPTZ;
  _latest_client_message_at TIMESTAMPTZ;
  _latest_operator_message_at TIMESTAMPTZ;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF NOT (
    public.is_conversation_client(_conversation_id)
    OR public.is_conversation_operator(_conversation_id)
    OR public.is_admin()
  ) THEN
    RAISE EXCEPTION 'not_allowed';
  END IF;

  SELECT client_id
  INTO _client_id
  FROM public.conversations
  WHERE id = _conversation_id;

  SELECT last_read_at
  INTO _client_last_read_at
  FROM public.conversation_read_states
  WHERE conversation_id = _conversation_id
    AND user_id = _client_id;

  SELECT max(crs.last_read_at)
  INTO _operator_last_read_at
  FROM public.conversation_read_states crs
  WHERE crs.conversation_id = _conversation_id
    AND crs.user_id <> _client_id;

  SELECT max(created_at)
  INTO _latest_client_message_at
  FROM public.messages
  WHERE conversation_id = _conversation_id
    AND sender_type = 'client'::public.sender_type;

  SELECT max(created_at)
  INTO _latest_operator_message_at
  FROM public.messages
  WHERE conversation_id = _conversation_id
    AND sender_type <> 'client'::public.sender_type;

  RETURN jsonb_build_object(
    'client_last_read_at', _client_last_read_at,
    'operator_last_read_at', _operator_last_read_at,
    'client_has_seen_latest_operator_message',
      _latest_operator_message_at IS NOT NULL
      AND _client_last_read_at IS NOT NULL
      AND _client_last_read_at >= _latest_operator_message_at,
    'operator_has_seen_latest_client_message',
      _latest_client_message_at IS NOT NULL
      AND _operator_last_read_at IS NOT NULL
      AND _operator_last_read_at >= _latest_client_message_at
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_conversation_read(UUID, TEXT) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_my_conversation_unread_counts(UUID[]) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_conversation_read_summary(UUID) FROM anon, public;

GRANT EXECUTE ON FUNCTION public.mark_conversation_read(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_conversation_unread_counts(UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_conversation_read_summary(UUID) TO authenticated;

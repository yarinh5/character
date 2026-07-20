-- Server-only picker thumbnail resolver. Object paths never reach browser callers.
CREATE OR REPLACE FUNCTION public.resolve_conversation_sticker_object_path_for_server(
  _actor_user_id UUID,
  _conversation_id UUID,
  _sticker_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation public.conversations%ROWTYPE;
  _operator_id UUID;
  _object_path TEXT;
BEGIN
  IF _actor_user_id IS NULL OR _conversation_id IS NULL OR _sticker_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF private.setting_bool('stickers_enabled', false) IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations c
  WHERE c.id = _conversation_id;

  IF NOT FOUND OR _conversation.status = 'closed'::public.conversation_status THEN
    RETURN NULL;
  END IF;

  IF _conversation.client_id = _actor_user_id THEN
    PERFORM private.ensure_active_client(_actor_user_id);

    IF _conversation.client_hidden_at IS NOT NULL OR EXISTS (
      SELECT 1
      FROM public.client_conversation_deletions d
      WHERE d.client_id = _actor_user_id
        AND d.conversation_id = _conversation_id
    ) THEN
      RETURN NULL;
    END IF;
  ELSE
    SELECT o.id
    INTO _operator_id
    FROM public.operators o
    WHERE o.user_id = _actor_user_id
      AND o.is_active = true
    LIMIT 1;

    IF _operator_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.character_operator_assignments coa
      WHERE coa.character_id = _conversation.character_id
        AND coa.operator_id = _operator_id
    ) THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT s.object_path
  INTO _object_path
  FROM public.stickers s
  JOIN public.sticker_collections sc ON sc.id = s.collection_id
  WHERE s.id = _sticker_id
    AND s.bucket_id = 'sticker-media'
    AND s.is_active = true
    AND sc.is_active = true
    AND (sc.character_id IS NULL OR sc.character_id = _conversation.character_id);

  RETURN _object_path;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_conversation_sticker_object_path_for_server(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_conversation_sticker_object_path_for_server(UUID, UUID, UUID)
  TO service_role;

NOTIFY pgrst, 'reload schema';

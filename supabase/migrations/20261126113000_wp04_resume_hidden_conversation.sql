-- WP04 AC11: hiding a conversation is personal and reversible; closed rows stay closed.
CREATE OR REPLACE FUNCTION public.start_or_get_conversation(_character_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client UUID;
  _conversation_id UUID;
  _hidden_at TIMESTAMPTZ;
  _character_available BOOLEAN;
  _resume_conflict BOOLEAN := FALSE;
  _conflict_constraint TEXT;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  _client := auth.uid();

  IF _client IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM private.ensure_active_client(_client);

  SELECT character.is_active AND character.is_visible
  INTO _character_available
  FROM public.characters character
  WHERE character.id = _character_id;

  IF _character_available IS NOT TRUE THEN
    RAISE EXCEPTION 'character_not_available';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(_client::TEXT), hashtext(_character_id::TEXT));

  SELECT conversation.id
  INTO _conversation_id
  FROM public.conversations conversation
  WHERE conversation.client_id = _client
    AND conversation.character_id = _character_id
    AND conversation.status <> 'closed'::public.conversation_status
    AND conversation.client_hidden_at IS NULL
  FOR UPDATE;

  IF _conversation_id IS NULL THEN
    -- Reuse the hidden non-closed history before opening a parallel conversation.
    SELECT conversation.id, conversation.client_hidden_at
    INTO _conversation_id, _hidden_at
    FROM public.conversations conversation
    WHERE conversation.client_id = _client
      AND conversation.character_id = _character_id
      AND conversation.status <> 'closed'::public.conversation_status
      AND conversation.client_hidden_at IS NOT NULL
    ORDER BY conversation.client_hidden_at DESC, conversation.id DESC
    LIMIT 1
    FOR UPDATE;
  END IF;

  IF _conversation_id IS NOT NULL THEN
    IF private.conversation_deletion_blocks_access(_conversation_id) THEN
      RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE = '42501';
    END IF;
    IF _hidden_at IS NULL THEN
      RETURN _conversation_id;
    END IF;

    BEGIN
      UPDATE public.conversations
      SET client_hidden_at = NULL, updated_at = now()
      WHERE id = _conversation_id;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS _conflict_constraint = CONSTRAINT_NAME;
      IF _conflict_constraint IS DISTINCT FROM 'conversations_one_visible_active_per_client_character' THEN
        RAISE;
      END IF;
      -- A status writer outside the pair lock made a different row visible.
      _resume_conflict := TRUE;
      _conversation_id := NULL;
    END;

    IF NOT _resume_conflict THEN
      DELETE FROM public.client_conversation_deletions
      WHERE client_id = _client AND conversation_id = _conversation_id;

      RETURN _conversation_id;
    END IF;
  END IF;

  IF NOT _resume_conflict THEN
    INSERT INTO public.conversations (
      client_id,
      character_id,
      assigned_operator_id,
      status,
      client_hidden_at
    )
    VALUES (
      _client,
      _character_id,
      NULL,
      'waiting'::public.conversation_status,
      NULL
    )
    ON CONFLICT (client_id, character_id)
    WHERE status <> 'closed'::public.conversation_status
      AND client_hidden_at IS NULL
    DO NOTHING
    RETURNING conversations.id INTO _conversation_id;
  END IF;

  IF _conversation_id IS NULL THEN
    SELECT conversation.id
    INTO _conversation_id
    FROM public.conversations conversation
    WHERE conversation.client_id = _client
      AND conversation.character_id = _character_id
      AND conversation.status <> 'closed'::public.conversation_status
      AND conversation.client_hidden_at IS NULL
    FOR UPDATE;
  END IF;

  IF _conversation_id IS NULL THEN
    RAISE EXCEPTION 'conversation_creation_conflict';
  END IF;

  IF private.conversation_deletion_blocks_access(_conversation_id) THEN
    RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE = '42501';
  END IF;

  RETURN _conversation_id;
END;
$$;

NOTIFY pgrst, 'reload schema';

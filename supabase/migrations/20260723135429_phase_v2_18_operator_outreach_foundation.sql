-- V2-18: server-side foundation for operator-initiated outreach.
-- Outreach is intentionally separate from the normal operator composer: it
-- writes a single operator message but never creates a credit payout.

CREATE TABLE public.operator_client_blocks (
  operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,
  client_id UUID NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_by_operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE RESTRICT,
  PRIMARY KEY (operator_id, client_id),
  CONSTRAINT operator_client_blocks_creator_matches_operator_check
    CHECK (created_by_operator_id = operator_id),
  CONSTRAINT operator_client_blocks_reason_length_check
    CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 500)
);

CREATE INDEX operator_client_blocks_client_id_idx
  ON public.operator_client_blocks (client_id);

CREATE TABLE public.operator_outreach_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE RESTRICT,
  client_id UUID NOT NULL,
  character_id UUID NOT NULL REFERENCES public.characters(id) ON DELETE RESTRICT,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  message_content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
  result JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT operator_outreach_attempts_idempotency_key_check
    CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  CONSTRAINT operator_outreach_attempts_message_content_check
    CHECK (char_length(btrim(message_content)) BETWEEN 1 AND 2000),
  CONSTRAINT operator_outreach_attempts_operator_idempotency_key_key
    UNIQUE (operator_id, idempotency_key)
);

CREATE INDEX operator_outreach_attempts_operator_client_character_created_idx
  ON public.operator_outreach_attempts (operator_id, client_id, character_id, created_at DESC);

CREATE INDEX operator_outreach_attempts_client_character_created_idx
  ON public.operator_outreach_attempts (client_id, character_id, created_at DESC);

ALTER TABLE public.operator_client_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_outreach_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.operator_client_blocks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.operator_outreach_attempts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_operator_online_candidates(
  _filters JSONB DEFAULT '{}'::JSONB
)
RETURNS TABLE(
  client_id UUID,
  display_name TEXT,
  avatar_url TEXT,
  has_existing_conversation BOOLEAN,
  character_options JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _operator_id UUID;
  _limit INTEGER := 50;
  _search TEXT := '';
  _character_id UUID;
  _requested_character_id TEXT;
  _requested_limit TEXT;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF jsonb_typeof(COALESCE(_filters, '{}'::JSONB)) <> 'object' THEN
    RAISE EXCEPTION 'invalid_outreach_filters';
  END IF;

  SELECT o.id
  INTO _operator_id
  FROM public.operators o
  WHERE o.user_id = _user_id
    AND o.is_active = true
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  _requested_limit := NULLIF(btrim(COALESCE(_filters->>'limit', '')), '');
  IF _requested_limit IS NOT NULL THEN
    IF _requested_limit !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'invalid_outreach_limit';
    END IF;
    _limit := LEAST(GREATEST(_requested_limit::INTEGER, 1), 100);
  END IF;

  _search := lower(left(btrim(COALESCE(_filters->>'search', '')), 100));
  _requested_character_id := NULLIF(btrim(COALESCE(_filters->>'character_id', '')), '');
  IF _requested_character_id IS NOT NULL THEN
    BEGIN
      _character_id := _requested_character_id::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'invalid_outreach_character_id';
    END;
  END IF;

  RETURN QUERY
  SELECT
    p.user_id,
    p.display_name,
    p.avatar_url,
    EXISTS (
      SELECT 1
      FROM public.conversations c
      WHERE c.client_id = p.user_id
        AND c.client_hidden_at IS NULL
        AND c.status <> 'closed'::public.conversation_status
        AND c.character_id IN (
          SELECT coa.character_id
          FROM public.character_operator_assignments coa
          WHERE coa.operator_id = _operator_id
        )
    ),
    options.character_options
  FROM public.profiles p
  JOIN public.user_roles ur
    ON ur.user_id = p.user_id
   AND ur.role = 'client'::public.app_role
  CROSS JOIN LATERAL (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'character_id', ch.id,
          'character_name', ch.name,
          'character_avatar_url', ch.avatar_url
        )
        ORDER BY ch.name
      ),
      '[]'::JSONB
    ) AS character_options
    FROM public.character_operator_assignments coa
    JOIN public.characters ch ON ch.id = coa.character_id
    WHERE coa.operator_id = _operator_id
      AND ch.is_active = true
      AND ch.is_visible = true
      AND (_character_id IS NULL OR ch.id = _character_id)
      AND NOT EXISTS (
        SELECT 1
        FROM public.conversation_work_items wi
        JOIN public.conversations c ON c.id = wi.conversation_id
        WHERE wi.client_id = p.user_id
          AND wi.character_id = ch.id
          AND wi.status = 'new'
          AND c.status <> 'closed'::public.conversation_status
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.conversation_handling_cycles cycle
        JOIN public.conversations c ON c.id = cycle.conversation_id
        WHERE c.client_id = p.user_id
          AND c.character_id = ch.id
          AND cycle.ended_at IS NULL
      )
  ) options
  WHERE p.status = 'active'
    AND p.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.operator_client_blocks block
      WHERE block.operator_id = _operator_id
        AND block.client_id = p.user_id
    )
    AND (_search = '' OR lower(COALESCE(p.display_name, '')) LIKE '%' || _search || '%')
    AND options.character_options <> '[]'::JSONB
  ORDER BY p.updated_at DESC, p.user_id
  LIMIT _limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_operator_outreach(
  _client_id UUID,
  _character_id UUID,
  _message TEXT,
  _idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _operator_id UUID;
  _message_clean TEXT := btrim(COALESCE(_message, ''));
  _idempotency_key_clean TEXT := btrim(COALESCE(_idempotency_key, ''));
  _attempt public.operator_outreach_attempts%ROWTYPE;
  _conversation_id UUID;
  _message_id UUID;
  _character_is_available BOOLEAN;
  _result JSONB;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF _client_id IS NULL OR _character_id IS NULL THEN
    RAISE EXCEPTION 'invalid_outreach_target';
  END IF;

  IF char_length(_message_clean) = 0 OR char_length(_message_clean) > 2000 THEN
    RAISE EXCEPTION 'invalid_outreach_message';
  END IF;

  IF char_length(_idempotency_key_clean) = 0 OR char_length(_idempotency_key_clean) > 200 THEN
    RAISE EXCEPTION 'invalid_outreach_idempotency_key';
  END IF;

  SELECT o.id
  INTO _operator_id
  FROM public.operators o
  WHERE o.user_id = _user_id
    AND o.is_active = true
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(_operator_id::TEXT),
    hashtext(_idempotency_key_clean)
  );

  SELECT *
  INTO _attempt
  FROM public.operator_outreach_attempts attempt
  WHERE attempt.operator_id = _operator_id
    AND attempt.idempotency_key = _idempotency_key_clean
  FOR UPDATE;

  IF FOUND THEN
    IF _attempt.client_id <> _client_id
       OR _attempt.character_id <> _character_id
       OR _attempt.message_content <> _message_clean THEN
      RAISE EXCEPTION 'outreach_idempotency_key_reused';
    END IF;

    RETURN _attempt.result || jsonb_build_object('idempotent_replay', true);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.character_operator_assignments coa
    WHERE coa.operator_id = _operator_id
      AND coa.character_id = _character_id
  ) THEN
    RAISE EXCEPTION 'operator_not_assigned_to_character';
  END IF;

  SELECT ch.is_active AND ch.is_visible
  INTO _character_is_available
  FROM public.characters ch
  WHERE ch.id = _character_id;

  IF _character_is_available IS NOT TRUE THEN
    RAISE EXCEPTION 'outreach_character_not_available';
  END IF;

  PERFORM private.ensure_active_client(_client_id);

  IF EXISTS (
    SELECT 1
    FROM public.operator_client_blocks block
    WHERE block.operator_id = _operator_id
      AND block.client_id = _client_id
  ) THEN
    RAISE EXCEPTION 'client_blocked_by_operator';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(_operator_id::TEXT),
    hashtext(_client_id::TEXT || ':' || _character_id::TEXT)
  );

  IF EXISTS (
    SELECT 1
    FROM public.operator_outreach_attempts attempt
    WHERE attempt.operator_id = _operator_id
      AND attempt.client_id = _client_id
      AND attempt.character_id = _character_id
      AND attempt.status = 'sent'
      AND attempt.created_at >= clock_timestamp() - INTERVAL '24 hours'
  ) THEN
    RAISE EXCEPTION 'outreach_rate_limited';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.conversation_work_items wi
    JOIN public.conversations c ON c.id = wi.conversation_id
    WHERE wi.client_id = _client_id
      AND wi.character_id = _character_id
      AND wi.status = 'new'
      AND c.status <> 'closed'::public.conversation_status
  ) THEN
    RAISE EXCEPTION 'outreach_pending_new_exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.conversation_handling_cycles cycle
    JOIN public.conversations c ON c.id = cycle.conversation_id
    WHERE c.client_id = _client_id
      AND c.character_id = _character_id
      AND cycle.ended_at IS NULL
  ) THEN
    RAISE EXCEPTION 'outreach_conversation_in_progress';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(_client_id::TEXT),
    hashtext(_character_id::TEXT)
  );

  SELECT c.id
  INTO _conversation_id
  FROM public.conversations c
  WHERE c.client_id = _client_id
    AND c.character_id = _character_id
    AND c.status <> 'closed'::public.conversation_status
    AND c.client_hidden_at IS NULL
  ORDER BY c.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF _conversation_id IS NULL THEN
    INSERT INTO public.conversations (
      client_id,
      character_id,
      assigned_operator_id,
      status,
      client_hidden_at
    )
    VALUES (
      _client_id,
      _character_id,
      NULL,
      'open'::public.conversation_status,
      NULL
    )
    ON CONFLICT (client_id, character_id)
    WHERE status <> 'closed'::public.conversation_status
      AND client_hidden_at IS NULL
    DO NOTHING
    RETURNING id INTO _conversation_id;

    IF _conversation_id IS NULL THEN
      SELECT c.id
      INTO _conversation_id
      FROM public.conversations c
      WHERE c.client_id = _client_id
        AND c.character_id = _character_id
        AND c.status <> 'closed'::public.conversation_status
        AND c.client_hidden_at IS NULL
      ORDER BY c.created_at DESC
      LIMIT 1
      FOR UPDATE;
    END IF;
  END IF;

  IF _conversation_id IS NULL THEN
    RAISE EXCEPTION 'outreach_conversation_creation_conflict';
  END IF;

  -- Outreach is never an eligible operator-message credit event. The normal
  -- message trigger still updates conversation state and unread counters.
  INSERT INTO public.messages (
    conversation_id,
    sender_type,
    sender_id,
    operator_id,
    content
  )
  VALUES (
    _conversation_id,
    'operator'::public.sender_type,
    _user_id,
    _operator_id,
    _message_clean
  )
  RETURNING id INTO _message_id;

  _result := jsonb_build_object(
    'outreach_id', gen_random_uuid(),
    'conversation_id', _conversation_id,
    'message_id', _message_id,
    'status', 'sent',
    'idempotent_replay', false
  );

  INSERT INTO public.operator_outreach_attempts (
    id,
    operator_id,
    client_id,
    character_id,
    conversation_id,
    message_id,
    idempotency_key,
    message_content,
    status,
    result
  )
  VALUES (
    (_result->>'outreach_id')::UUID,
    _operator_id,
    _client_id,
    _character_id,
    _conversation_id,
    _message_id,
    _idempotency_key_clean,
    _message_clean,
    'sent',
    _result
  );

  INSERT INTO public.audit_logs (
    actor_user_id,
    action,
    entity_type,
    entity_id,
    metadata
  )
  VALUES (
    _user_id,
    'operator_outreach_started',
    'conversation',
    _conversation_id,
    jsonb_build_object(
      'operator_id', _operator_id,
      'client_id', _client_id,
      'character_id', _character_id,
      'outreach_id', _result->>'outreach_id'
    )
  );

  RETURN _result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_operator_online_candidates(JSONB)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operator_online_candidates(JSONB)
  TO authenticated;

REVOKE ALL ON FUNCTION public.start_operator_outreach(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_operator_outreach(UUID, UUID, TEXT, TEXT)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

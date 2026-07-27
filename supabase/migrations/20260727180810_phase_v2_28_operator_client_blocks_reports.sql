-- V2-28: operator-scoped client blocks and reports.
-- Blocks reuse the V2-18 table and are deleted on unblock, so its primary key
-- remains the unique active block for an operator/client pair.

CREATE TABLE public.operator_client_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE RESTRICT,
  client_id UUID NOT NULL,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT operator_client_reports_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  CONSTRAINT operator_client_reports_notes_check
    CHECK (notes IS NULL OR char_length(btrim(notes)) <= 2000),
  CONSTRAINT operator_client_reports_source_check
    CHECK (source IN ('chat', 'online', 'new'))
);

CREATE INDEX operator_client_reports_operator_created_idx
  ON public.operator_client_reports (operator_id, created_at DESC);
CREATE INDEX operator_client_reports_client_created_idx
  ON public.operator_client_reports (client_id, created_at DESC);

ALTER TABLE public.operator_client_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.operator_client_reports FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.get_current_active_operator_id()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _operator_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  IF public.is_admin() IS TRUE THEN
    RAISE EXCEPTION 'operator_only';
  END IF;

  SELECT id
  INTO _operator_id
  FROM public.operators
  WHERE user_id = auth.uid()
    AND is_active = TRUE
    AND deleted_at IS NULL
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  RETURN _operator_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.assert_operator_client_block_context(
  _operator_id UUID,
  _client_id UUID,
  _conversation_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation public.conversations%ROWTYPE;
BEGIN
  IF _client_id IS NULL THEN
    RAISE EXCEPTION 'client_required';
  END IF;

  IF _conversation_id IS NULL THEN
    PERFORM private.ensure_active_client(_client_id);
    RETURN;
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations
  WHERE id = _conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF _conversation.client_id <> _client_id THEN
    RAISE EXCEPTION 'conversation_client_mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.character_operator_assignments assignment
    WHERE assignment.operator_id = _operator_id
      AND assignment.character_id = _conversation.character_id
  ) THEN
    RAISE EXCEPTION 'operator_not_assigned_to_character';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.block_client_for_operator(
  _client_id UUID,
  _reason TEXT,
  _notes TEXT DEFAULT NULL,
  _conversation_id UUID DEFAULT NULL,
  _source TEXT DEFAULT 'chat'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _operator_id UUID := private.get_current_active_operator_id();
  _reason_clean TEXT := btrim(COALESCE(_reason, ''));
  _notes_clean TEXT := NULLIF(btrim(COALESCE(_notes, '')), '');
  _source_clean TEXT := lower(btrim(COALESCE(_source, 'chat')));
  _created BOOLEAN := FALSE;
  _rows INTEGER := 0;
BEGIN
  IF char_length(_reason_clean) < 3 OR char_length(_reason_clean) > 500 THEN
    RAISE EXCEPTION 'invalid_block_reason';
  END IF;

  IF _notes_clean IS NOT NULL AND char_length(_notes_clean) > 2000 THEN
    RAISE EXCEPTION 'block_notes_too_long';
  END IF;

  IF _source_clean NOT IN ('chat', 'online', 'new') THEN
    RAISE EXCEPTION 'invalid_block_source';
  END IF;

  PERFORM private.assert_operator_client_block_context(_operator_id, _client_id, _conversation_id);

  INSERT INTO public.operator_client_blocks (
    operator_id,
    client_id,
    reason,
    created_by_operator_id
  )
  VALUES (_operator_id, _client_id, _reason_clean, _operator_id)
  ON CONFLICT (operator_id, client_id) DO NOTHING;

  GET DIAGNOSTICS _rows = ROW_COUNT;
  _created := _rows > 0;

  IF _created THEN
    INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (
      auth.uid(),
      'operator_client.blocked',
      'operator_client_block',
      _operator_id::TEXT || ':' || _client_id::TEXT,
      jsonb_build_object(
        'operator_id', _operator_id,
        'client_id', _client_id,
        'conversation_id', _conversation_id,
        'reason', _reason_clean,
        'notes_length', COALESCE(char_length(_notes_clean), 0),
        'source', _source_clean
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'blocked', TRUE,
    'idempotent_replay', NOT _created,
    'operator_id', _operator_id,
    'client_id', _client_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.unblock_client_for_operator(_client_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _operator_id UUID := private.get_current_active_operator_id();
  _deleted BOOLEAN := FALSE;
  _rows INTEGER := 0;
BEGIN
  IF _client_id IS NULL THEN
    RAISE EXCEPTION 'client_required';
  END IF;

  DELETE FROM public.operator_client_blocks
  WHERE operator_id = _operator_id
    AND client_id = _client_id;

  GET DIAGNOSTICS _rows = ROW_COUNT;
  _deleted := _rows > 0;

  IF _deleted THEN
    INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (
      auth.uid(),
      'operator_client.unblocked',
      'operator_client_block',
      _operator_id::TEXT || ':' || _client_id::TEXT,
      jsonb_build_object('operator_id', _operator_id, 'client_id', _client_id)
    );
  END IF;

  RETURN jsonb_build_object('unblocked', _deleted, 'operator_id', _operator_id, 'client_id', _client_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.report_client_as_operator(
  _client_id UUID,
  _reason TEXT,
  _notes TEXT DEFAULT NULL,
  _conversation_id UUID DEFAULT NULL,
  _source TEXT DEFAULT 'chat'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _operator_id UUID := private.get_current_active_operator_id();
  _reason_clean TEXT := btrim(COALESCE(_reason, ''));
  _notes_clean TEXT := NULLIF(btrim(COALESCE(_notes, '')), '');
  _source_clean TEXT := lower(btrim(COALESCE(_source, 'chat')));
  _report_id UUID;
BEGIN
  IF char_length(_reason_clean) < 3 OR char_length(_reason_clean) > 500 THEN
    RAISE EXCEPTION 'invalid_report_reason';
  END IF;

  IF _notes_clean IS NOT NULL AND char_length(_notes_clean) > 2000 THEN
    RAISE EXCEPTION 'report_notes_too_long';
  END IF;

  IF _source_clean NOT IN ('chat', 'online', 'new') THEN
    RAISE EXCEPTION 'invalid_report_source';
  END IF;

  PERFORM private.assert_operator_client_block_context(_operator_id, _client_id, _conversation_id);

  INSERT INTO public.operator_client_reports (
    operator_id,
    client_id,
    conversation_id,
    reason,
    notes,
    source
  )
  VALUES (
    _operator_id,
    _client_id,
    _conversation_id,
    _reason_clean,
    _notes_clean,
    _source_clean
  )
  RETURNING id INTO _report_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    auth.uid(),
    'operator_client.reported',
    'operator_client_report',
    _report_id::TEXT,
    jsonb_build_object(
      'operator_id', _operator_id,
      'client_id', _client_id,
      'conversation_id', _conversation_id,
      'reason', _reason_clean,
      'notes_length', COALESCE(char_length(_notes_clean), 0),
      'source', _source_clean
    )
  );

  RETURN jsonb_build_object('report_id', _report_id, 'operator_id', _operator_id, 'client_id', _client_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_operator_client_block_status(_client_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _operator_id UUID := private.get_current_active_operator_id();
  _block public.operator_client_blocks%ROWTYPE;
BEGIN
  IF _client_id IS NULL THEN
    RAISE EXCEPTION 'client_required';
  END IF;

  SELECT *
  INTO _block
  FROM public.operator_client_blocks
  WHERE operator_id = _operator_id
    AND client_id = _client_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('is_blocked', FALSE);
  END IF;

  RETURN jsonb_build_object(
    'is_blocked', TRUE,
    'reason', _block.reason,
    'created_at', _block.created_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_operator_client_reports()
RETURNS TABLE (
  id UUID,
  operator_id UUID,
  operator_name TEXT,
  client_id UUID,
  client_display_name TEXT,
  conversation_id UUID,
  reason TEXT,
  notes TEXT,
  source TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  RETURN QUERY
  SELECT
    report.id,
    report.operator_id,
    operator.full_name,
    report.client_id,
    profile.display_name,
    report.conversation_id,
    report.reason,
    report.notes,
    report.source,
    report.created_at
  FROM public.operator_client_reports report
  JOIN public.operators operator ON operator.id = report.operator_id
  LEFT JOIN public.profiles profile ON profile.user_id = report.client_id
  ORDER BY report.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_operator_new_queue()
RETURNS TABLE (
  work_item_id UUID,
  conversation_id UUID,
  character_id UUID,
  status TEXT,
  queue_state TEXT,
  client_display_name TEXT,
  character_name TEXT,
  character_avatar_url TEXT,
  last_client_preview TEXT,
  last_activity_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _operator_id UUID;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT o.id
  INTO _operator_id
  FROM public.operators o
  WHERE o.user_id = _user_id
    AND o.is_active = TRUE
    AND o.deleted_at IS NULL
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  RETURN QUERY
  SELECT
    wi.id,
    wi.conversation_id,
    wi.character_id,
    wi.status,
    CASE
      WHEN last_cycle.end_reason IN ('released', 'reassigned', 'timeout')
        AND client_message.created_at <= last_cycle.ended_at THEN 'returned'
      ELSE 'new'
    END,
    p.display_name,
    ch.name,
    ch.avatar_url,
    COALESCE(client_message.content, c.last_message_preview, ''),
    wi.last_activity_at,
    wi.created_at
  FROM public.conversation_work_items wi
  JOIN public.conversations c ON c.id = wi.conversation_id
  JOIN public.characters ch ON ch.id = wi.character_id
  JOIN public.messages client_message ON client_message.id = wi.last_client_message_id
  LEFT JOIN public.profiles p ON p.user_id = wi.client_id
  LEFT JOIN LATERAL (
    SELECT cycle.end_reason, cycle.ended_at
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.work_item_id = wi.id
      AND cycle.ended_at IS NOT NULL
    ORDER BY cycle.ended_at DESC
    LIMIT 1
  ) last_cycle ON TRUE
  WHERE wi.status = 'new'
    AND c.status <> 'closed'::public.conversation_status
    AND client_message.sender_type = 'client'::public.sender_type
    AND NOT EXISTS (
      SELECT 1
      FROM public.conversation_handling_cycles cycle
      WHERE cycle.work_item_id = wi.id
        AND cycle.ended_at IS NULL
    )
    AND EXISTS (
      SELECT 1
      FROM public.character_operator_assignments assignment
      WHERE assignment.character_id = wi.character_id
        AND assignment.operator_id = _operator_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.operator_client_blocks block
      WHERE block.operator_id = _operator_id
        AND block.client_id = wi.client_id
    )
  ORDER BY wi.last_activity_at DESC, wi.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_new_conversation(_work_item_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _guard RECORD;
  _work_item public.conversation_work_items%ROWTYPE;
  _conversation_id UUID;
BEGIN
  SELECT conversation_id
  INTO _conversation_id
  FROM public.conversation_work_items
  WHERE id = _work_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_item_not_found';
  END IF;

  SELECT *
  INTO _guard
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);

  SELECT *
  INTO _work_item
  FROM public.conversation_work_items
  WHERE id = _work_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_item_not_found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.operator_client_blocks block
    WHERE block.operator_id = _guard.operator_id
      AND block.client_id = _work_item.client_id
  ) THEN
    RAISE EXCEPTION 'client_blocked_by_operator';
  END IF;

  IF _work_item.status <> 'new' THEN
    IF _work_item.responsible_operator_id = _guard.operator_id THEN
      RETURN jsonb_build_object(
        'claimed', TRUE,
        'already_claimed', TRUE,
        'work_item_id', _work_item.id,
        'conversation_id', _work_item.conversation_id,
        'status', _work_item.status
      );
    END IF;

    RAISE EXCEPTION 'conversation_already_claimed';
  END IF;

  UPDATE public.conversations
  SET assigned_operator_id = _guard.operator_id,
      updated_at = clock_timestamp()
  WHERE id = _work_item.conversation_id;

  UPDATE public.conversation_work_items
  SET status = 'assigned',
      responsible_operator_id = _guard.operator_id,
      assigned_at = clock_timestamp()
  WHERE id = _work_item.id
  RETURNING * INTO _work_item;

  INSERT INTO public.conversation_handling_cycles (
    conversation_id,
    work_item_id,
    operator_id,
    started_at
  )
  VALUES (
    _work_item.conversation_id,
    _work_item.id,
    _guard.operator_id,
    clock_timestamp()
  );

  RETURN jsonb_build_object(
    'claimed', TRUE,
    'already_claimed', FALSE,
    'work_item_id', _work_item.id,
    'conversation_id', _work_item.conversation_id,
    'status', _work_item.status
  );
END;
$$;

REVOKE ALL ON FUNCTION private.get_current_active_operator_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.assert_operator_client_block_context(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.get_current_active_operator_id() TO service_role;
GRANT EXECUTE ON FUNCTION private.assert_operator_client_block_context(UUID, UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.block_client_for_operator(UUID, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unblock_client_for_operator(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.report_client_as_operator(UUID, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_my_operator_client_block_status(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admin_operator_client_reports() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.block_client_for_operator(UUID, TEXT, TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unblock_client_for_operator(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_client_as_operator(UUID, TEXT, TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_operator_client_block_status(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_operator_client_reports() TO authenticated;

REVOKE ALL ON FUNCTION public.get_operator_new_queue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operator_new_queue() TO authenticated;

REVOKE ALL ON FUNCTION public.claim_new_conversation(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_new_conversation(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- V2-27: route sensitive admin browser writes through audited, guarded RPCs.

CREATE OR REPLACE FUNCTION public.admin_reassign_conversation(
  _conversation_id UUID,
  _operator_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _admin_id UUID := auth.uid();
  _conversation public.conversations%ROWTYPE;
  _operator public.operators%ROWTYPE;
BEGIN
  IF _admin_id IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF _conversation_id IS NULL THEN
    RAISE EXCEPTION 'conversation_required';
  END IF;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_required';
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations
  WHERE id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  SELECT *
  INTO _operator
  FROM public.operators
  WHERE id = _operator_id
    AND is_active = TRUE
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator_not_active';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.character_operator_assignments assignment
    WHERE assignment.operator_id = _operator_id
      AND assignment.character_id = _conversation.character_id
  ) THEN
    RAISE EXCEPTION 'operator_not_assigned_to_character';
  END IF;

  UPDATE public.conversations
  SET
    assigned_operator_id = _operator_id,
    status = 'open'::public.conversation_status
  WHERE id = _conversation_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'conversation.reassigned',
    'conversation',
    _conversation_id::TEXT,
    jsonb_build_object(
      'previous_operator_id', _conversation.assigned_operator_id,
      'operator_id', _operator_id,
      'previous_status', _conversation.status,
      'status', 'open'
    )
  );

  RETURN jsonb_build_object('conversation_id', _conversation_id, 'operator_id', _operator_id, 'status', 'open');
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_conversation_status(
  _conversation_id UUID,
  _status public.conversation_status
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _admin_id UUID := auth.uid();
  _previous_status public.conversation_status;
BEGIN
  IF _admin_id IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF _conversation_id IS NULL THEN
    RAISE EXCEPTION 'conversation_required';
  END IF;

  IF _status IS NULL THEN
    RAISE EXCEPTION 'status_required';
  END IF;

  SELECT status
  INTO _previous_status
  FROM public.conversations
  WHERE id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  UPDATE public.conversations
  SET status = _status
  WHERE id = _conversation_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'conversation.status_changed',
    'conversation',
    _conversation_id::TEXT,
    jsonb_build_object('previous_status', _previous_status, 'status', _status)
  );

  RETURN jsonb_build_object('conversation_id', _conversation_id, 'status', _status);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_add_conversation_note(
  _conversation_id UUID,
  _note TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _admin_id UUID := auth.uid();
  _operator_id UUID;
  _note_id UUID;
  _trimmed_note TEXT := btrim(COALESCE(_note, ''));
BEGIN
  IF _admin_id IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF _conversation_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.conversations WHERE id = _conversation_id) THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF char_length(_trimmed_note) = 0 THEN
    RAISE EXCEPTION 'note_required';
  END IF;

  IF char_length(_trimmed_note) > 2000 THEN
    RAISE EXCEPTION 'note_too_long';
  END IF;

  SELECT id
  INTO _operator_id
  FROM public.operators
  WHERE user_id = _admin_id
    AND deleted_at IS NULL
  LIMIT 1;

  INSERT INTO public.internal_notes (conversation_id, operator_id, note)
  VALUES (_conversation_id, _operator_id, _trimmed_note)
  RETURNING id INTO _note_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'conversation.note_added',
    'conversation',
    _conversation_id::TEXT,
    jsonb_build_object('note_id', _note_id, 'length', char_length(_trimmed_note))
  );

  RETURN _note_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_add_customer_info_entry(
  _conversation_id UUID,
  _content TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _admin_id UUID := auth.uid();
  _operator_id UUID;
  _client_id UUID;
  _entry_id UUID;
  _trimmed_content TEXT := btrim(COALESCE(_content, ''));
BEGIN
  IF _admin_id IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF _conversation_id IS NULL THEN
    RAISE EXCEPTION 'conversation_required';
  END IF;

  IF char_length(_trimmed_content) = 0 THEN
    RAISE EXCEPTION 'customer_info_required';
  END IF;

  IF char_length(_trimmed_content) > 2000 THEN
    RAISE EXCEPTION 'customer_info_too_long';
  END IF;

  SELECT client_id
  INTO _client_id
  FROM public.conversations
  WHERE id = _conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  SELECT id
  INTO _operator_id
  FROM public.operators
  WHERE user_id = _admin_id
    AND is_active = TRUE
    AND deleted_at IS NULL
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'admin_operator_profile_required';
  END IF;

  INSERT INTO public.customer_info_entries (
    client_id,
    conversation_id,
    operator_id,
    created_by_user_id,
    content
  )
  VALUES (
    _client_id,
    _conversation_id,
    _operator_id,
    _admin_id,
    _trimmed_content
  )
  RETURNING id INTO _entry_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'customer_info.added',
    'conversation',
    _conversation_id::TEXT,
    jsonb_build_object('entry_id', _entry_id, 'client_id', _client_id, 'length', char_length(_trimmed_content))
  );

  RETURN _entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_report_status(
  _report_id UUID,
  _status public.report_status
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _admin_id UUID := auth.uid();
  _previous_status public.report_status;
BEGIN
  IF _admin_id IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  IF _report_id IS NULL THEN
    RAISE EXCEPTION 'report_required';
  END IF;

  IF _status IS NULL THEN
    RAISE EXCEPTION 'report_status_required';
  END IF;

  SELECT status
  INTO _previous_status
  FROM public.reports
  WHERE id = _report_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'report_not_found';
  END IF;

  UPDATE public.reports
  SET status = _status
  WHERE id = _report_id;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'report.status_changed',
    'report',
    _report_id::TEXT,
    jsonb_build_object('previous_status', _previous_status, 'status', _status)
  );

  RETURN jsonb_build_object('report_id', _report_id, 'status', _status);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_reassign_conversation(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_conversation_status(UUID, public.conversation_status) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_add_conversation_note(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_add_customer_info_entry(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_update_report_status(UUID, public.report_status) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.admin_reassign_conversation(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_conversation_status(UUID, public.conversation_status) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_conversation_note(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_customer_info_entry(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_report_status(UUID, public.report_status) TO authenticated;

DROP POLICY IF EXISTS "Admins manage conversations" ON public.conversations;
CREATE POLICY "Admins view all conversations" ON public.conversations
  FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Admins manage all notes" ON public.internal_notes;
CREATE POLICY "Admins view all notes" ON public.internal_notes
  FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Admins manage customer info" ON public.customer_info_entries;
CREATE POLICY "Admins view customer info" ON public.customer_info_entries
  FOR SELECT
  USING (public.is_admin());

DROP POLICY IF EXISTS "Admins manage reports" ON public.reports;
CREATE POLICY "Admins view all reports" ON public.reports
  FOR SELECT
  USING (public.is_admin());

NOTIFY pgrst, 'reload schema';

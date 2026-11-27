CREATE OR REPLACE FUNCTION public.admin_reassign_conversation(
  _conversation_id uuid,
  _operator_id uuid,
  _reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _admin_id uuid := auth.uid();
  _reason_clean text := NULLIF(btrim(_reason), '');
  _conversation public.conversations%ROWTYPE;
  _previous_cycle public.conversation_handling_cycles%ROWTYPE;
  _work_item public.conversation_work_items%ROWTYPE;
  _new_cycle public.conversation_handling_cycles%ROWTYPE;
  _active_count integer;
  _previous_cycle_found boolean;
  _work_item_found boolean;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _admin_id IS NULL OR public.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF _reason_clean IS NULL OR char_length(_reason_clean) < 3 OR char_length(_reason_clean) > 500 THEN
    RAISE EXCEPTION 'admin_transfer_reason_required';
  END IF;

  SELECT * INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  IF _conversation.status = 'closed'::public.conversation_status THEN RAISE EXCEPTION 'conversation_closed'; END IF;
  IF _conversation.inactivity_expires_at IS NULL
     OR _conversation.inactivity_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'handling_cycle_expired';
  END IF;

  SELECT * INTO _previous_cycle
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.conversation_id = _conversation_id AND cycle.ended_at IS NULL
  FOR UPDATE;
  _previous_cycle_found := FOUND;

  IF _previous_cycle_found THEN
    SELECT * INTO _work_item
    FROM public.conversation_work_items work_item
    WHERE work_item.id = _previous_cycle.work_item_id
    FOR UPDATE;
  ELSE
    SELECT * INTO _work_item
    FROM public.conversation_work_items work_item
    WHERE work_item.conversation_id = _conversation_id
      AND work_item.status IN ('new', 'assigned', 'in_progress')
    FOR UPDATE;
  END IF;
  _work_item_found := FOUND;

  PERFORM 1 FROM public.operators operator
  WHERE operator.id = _operator_id
    AND operator.is_active IS TRUE
    AND operator.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operator_not_active'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.character_operator_assignments assignment
    WHERE assignment.operator_id = _operator_id
      AND assignment.character_id = _conversation.character_id
  ) THEN RAISE EXCEPTION 'operator_not_assigned_to_character'; END IF;

  SELECT count(*)::integer INTO _active_count
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.operator_id = _operator_id
    AND cycle.ended_at IS NULL
    AND cycle.conversation_id <> _conversation_id;
  IF _active_count >= 5 THEN RAISE EXCEPTION 'operator_capacity_reached'; END IF;

  IF _previous_cycle_found AND _previous_cycle.operator_id = _operator_id THEN
    RETURN jsonb_build_object(
      'conversation_id', _conversation_id,
      'operator_id', _operator_id,
      'cycle_id', _previous_cycle.id,
      'already_assigned', true
    );
  END IF;

  IF _previous_cycle_found THEN
    UPDATE public.conversation_handling_cycles
    SET ended_at = clock_timestamp(), end_reason = 'reassigned'
    WHERE id = _previous_cycle.id;

    UPDATE public.conversation_locks
    SET released_at = clock_timestamp(),
        released_by_user_id = _admin_id,
        release_reason = 'reassigned'
    WHERE conversation_id = _conversation_id AND released_at IS NULL;
  END IF;

  IF NOT _work_item_found THEN
    INSERT INTO public.conversation_work_items (
      conversation_id, client_id, character_id, status,
      responsible_operator_id, assigned_at, last_activity_at
    ) VALUES (
      _conversation_id, _conversation.client_id, _conversation.character_id,
      'assigned', _operator_id, clock_timestamp(),
      COALESCE(_conversation.last_business_message_at, clock_timestamp())
    ) RETURNING * INTO _work_item;
  ELSE
    UPDATE public.conversation_work_items
    SET status = 'assigned', responsible_operator_id = _operator_id,
        assigned_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE id = _work_item.id
    RETURNING * INTO _work_item;
  END IF;

  UPDATE public.conversations
  SET assigned_operator_id = _operator_id,
      status = 'open'::public.conversation_status,
      updated_at = clock_timestamp()
  WHERE id = _conversation_id;

  INSERT INTO public.conversation_handling_cycles (conversation_id, work_item_id, operator_id)
  VALUES (_conversation_id, _work_item.id, _operator_id)
  RETURNING * INTO _new_cycle;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _admin_id,
    'conversation.reassigned',
    'conversation',
    _conversation_id::text,
    jsonb_build_object(
      'previous_operator_id', _conversation.assigned_operator_id,
      'operator_id', _operator_id,
      'previous_cycle_id', _previous_cycle.id,
      'cycle_id', _new_cycle.id,
      'reason', _reason_clean
    )
  );

  RETURN jsonb_build_object(
    'conversation_id', _conversation_id,
    'operator_id', _operator_id,
    'cycle_id', _new_cycle.id,
    'already_assigned', false
  );
END;
$$;

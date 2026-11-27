-- Reject absent/elapsed inactivity deadlines on new claims only.
-- Preserve replay, legacy-lock policy, eligibility, ACLs and lock order.
-- Recheck server time after the existing row locks, before assignment writes.

CREATE OR REPLACE FUNCTION private.allocate_new_conversations(
  _max_assignments integer DEFAULT 50,
  _fresh_operator_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _heartbeat_stale_minutes integer := GREATEST(private.setting_int('operator_heartbeat_stale_minutes', 5), 1);
  _work_item public.conversation_work_items%ROWTYPE;
  _conversation public.conversations%ROWTYPE;
  _operator_id uuid;
  _cycle_id uuid;
  _allocated integer := 0;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  IF _max_assignments IS NULL OR _max_assignments < 1 OR _max_assignments > 500 THEN
    RAISE EXCEPTION 'invalid_allocation_limit';
  END IF;

  FOR _work_item IN
    SELECT work_item.*
    FROM public.conversation_work_items work_item
    JOIN public.conversations conversation ON conversation.id = work_item.conversation_id
    JOIN public.profiles profile ON profile.user_id = work_item.client_id
    JOIN public.characters character ON character.id = work_item.character_id
    WHERE work_item.status = 'new'
      AND conversation.status <> 'closed'::public.conversation_status
      AND conversation.assigned_operator_id IS NULL
      AND conversation.needs_handling IS TRUE
      AND conversation.pending_since IS NOT NULL
      AND conversation.inactivity_expires_at IS NOT NULL
      AND conversation.inactivity_expires_at > clock_timestamp()
      AND profile.status = 'active'
      AND profile.deleted_at IS NULL
      AND profile.pii_archived_at IS NULL
      AND character.is_active IS TRUE
      AND NOT EXISTS (
        SELECT 1 FROM public.conversation_handling_cycles cycle
        WHERE cycle.conversation_id = work_item.conversation_id AND cycle.ended_at IS NULL
      )
    ORDER BY conversation.pending_since ASC, work_item.id ASC
    FOR UPDATE OF conversation SKIP LOCKED
    LIMIT _max_assignments
  LOOP
    SELECT * INTO _conversation
    FROM public.conversations conversation
    WHERE conversation.id = _work_item.conversation_id
    FOR UPDATE;

    SELECT * INTO _work_item
    FROM public.conversation_work_items work_item
    WHERE work_item.id = _work_item.id
    FOR UPDATE;

    IF _work_item.status <> 'new'
       OR _conversation.needs_handling IS NOT TRUE
       OR _conversation.assigned_operator_id IS NOT NULL
       OR _conversation.status = 'closed'::public.conversation_status THEN
      CONTINUE;
    END IF;

    _operator_id := NULL;
    SELECT operator.id INTO _operator_id
    FROM public.operators operator
    JOIN public.character_operator_assignments assignment
      ON assignment.operator_id = operator.id
     AND assignment.character_id = _work_item.character_id
    WHERE operator.is_active IS TRUE
      AND operator.deleted_at IS NULL
      AND operator.availability_status = 'available'::public.availability_status
      AND (
        operator.id = _fresh_operator_id
        OR (
          operator.presence_status = 'online'
          AND operator.last_seen_at >= clock_timestamp() - make_interval(mins => _heartbeat_stale_minutes)
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.operator_client_blocks block
        WHERE block.operator_id = operator.id AND block.client_id = _work_item.client_id
      )
      AND (
        SELECT count(*) FROM public.conversation_handling_cycles active_cycle
        WHERE active_cycle.operator_id = operator.id AND active_cycle.ended_at IS NULL
      ) < 5
    ORDER BY
      (
        SELECT count(*) FROM public.conversation_handling_cycles active_cycle
        WHERE active_cycle.operator_id = operator.id AND active_cycle.ended_at IS NULL
      ) ASC,
      (
        SELECT max(previous_cycle.started_at) FROM public.conversation_handling_cycles previous_cycle
        WHERE previous_cycle.operator_id = operator.id
      ) ASC NULLS FIRST,
      operator.id ASC
    FOR UPDATE OF operator SKIP LOCKED
    LIMIT 1;

    IF _operator_id IS NULL THEN
      CONTINUE;
    END IF;

    IF _conversation.inactivity_expires_at IS NULL
       OR _conversation.inactivity_expires_at <= clock_timestamp() THEN
      CONTINUE;
    END IF;

    UPDATE public.conversations
    SET assigned_operator_id = _operator_id,
        updated_at = clock_timestamp()
    WHERE id = _work_item.conversation_id
      AND assigned_operator_id IS NULL;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    UPDATE public.conversation_work_items
    SET status = 'assigned',
        responsible_operator_id = _operator_id,
        assigned_at = clock_timestamp(),
        updated_at = clock_timestamp()
    WHERE id = _work_item.id
      AND status = 'new';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'conversation_claim_state_inconsistent';
    END IF;

    INSERT INTO public.conversation_handling_cycles (
      conversation_id, work_item_id, operator_id, started_at
    ) VALUES (
      _work_item.conversation_id, _work_item.id, _operator_id, clock_timestamp()
    ) RETURNING id INTO _cycle_id;

    INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (
      NULL,
      'conversation.auto_assigned',
      'conversation',
      _work_item.conversation_id::text,
      jsonb_build_object(
        'operator_id', _operator_id,
        'cycle_id', _cycle_id,
        'capacity_limit', 5,
        'pending_since', _conversation.pending_since
      )
    );

    _allocated := _allocated + 1;
  END LOOP;

  RETURN _allocated;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_new_conversation(_work_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _guard record;
  _conversation_id uuid;
  _work_item public.conversation_work_items%ROWTYPE;
  _conversation public.conversations%ROWTYPE;
  _cycle public.conversation_handling_cycles%ROWTYPE;
  _operator public.operators%ROWTYPE;
  _active_count integer;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  SELECT work_item.conversation_id INTO _conversation_id
  FROM public.conversation_work_items work_item
  WHERE work_item.id = _work_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'work_item_not_found'; END IF;

  SELECT * INTO _guard
  FROM private.assert_operator_can_claim_conversation(_conversation_id);

  SELECT * INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
  FOR UPDATE;

  SELECT * INTO _work_item
  FROM public.conversation_work_items work_item
  WHERE work_item.id = _work_item_id
    AND work_item.conversation_id = _conversation.id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'work_item_not_found'; END IF;

  IF _work_item.status IN ('assigned', 'in_progress')
     AND _work_item.responsible_operator_id = _guard.operator_id
     AND _conversation.assigned_operator_id = _guard.operator_id THEN
    SELECT * INTO _cycle
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.work_item_id = _work_item.id
      AND cycle.operator_id = _guard.operator_id
      AND cycle.ended_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'conversation_claim_state_inconsistent'; END IF;
    RETURN jsonb_build_object(
      'claimed', true,
      'already_claimed', true,
      'work_item_id', _work_item.id,
      'conversation_id', _work_item.conversation_id,
      'status', _work_item.status,
      'cycle_id', _cycle.id
    );
  END IF;

  IF _work_item.status <> 'new'
     OR _conversation.assigned_operator_id IS NOT NULL
     OR _conversation.needs_handling IS NOT TRUE
     OR _conversation.pending_since IS NULL THEN
    RAISE EXCEPTION 'conversation_already_claimed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.operator_client_blocks block
    WHERE block.operator_id = _guard.operator_id AND block.client_id = _work_item.client_id
  ) THEN RAISE EXCEPTION 'client_blocked_by_operator'; END IF;

  SELECT * INTO _operator
  FROM public.operators operator
  WHERE operator.id = _guard.operator_id
  FOR UPDATE;

  IF _operator.presence_status <> 'online'
     OR _operator.availability_status <> 'available'::public.availability_status
     OR _operator.last_seen_at IS NULL
     OR _operator.last_seen_at < clock_timestamp() - make_interval(mins => GREATEST(private.setting_int('operator_heartbeat_stale_minutes', 5), 1)) THEN
    RAISE EXCEPTION 'operator_not_connected';
  END IF;

  SELECT count(*)::integer INTO _active_count
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.operator_id = _guard.operator_id AND cycle.ended_at IS NULL;
  IF _active_count >= 5 THEN RAISE EXCEPTION 'operator_capacity_reached'; END IF;

  IF _conversation.inactivity_expires_at IS NULL
     OR _conversation.inactivity_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'conversation_claim_state_expired';
  END IF;

  UPDATE public.conversations
  SET assigned_operator_id = _guard.operator_id, updated_at = clock_timestamp()
  WHERE id = _conversation.id AND assigned_operator_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_already_claimed'; END IF;

  UPDATE public.conversation_work_items
  SET status = 'assigned', responsible_operator_id = _guard.operator_id,
      assigned_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE id = _work_item.id AND status = 'new'
  RETURNING * INTO _work_item;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_already_claimed'; END IF;

  INSERT INTO public.conversation_handling_cycles (conversation_id, work_item_id, operator_id)
  VALUES (_work_item.conversation_id, _work_item.id, _guard.operator_id)
  RETURNING * INTO _cycle;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _guard.user_id,
    'conversation.claimed',
    'conversation',
    _work_item.conversation_id::text,
    jsonb_build_object('operator_id', _guard.operator_id, 'cycle_id', _cycle.id)
  );

  RETURN jsonb_build_object(
    'claimed', true,
    'already_claimed', false,
    'work_item_id', _work_item.id,
    'conversation_id', _work_item.conversation_id,
    'status', _work_item.status,
    'cycle_id', _cycle.id
  );
END;
$$;

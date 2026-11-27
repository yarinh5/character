-- WP01.6 / WP02: explicit Admin transfer, capacity-aware automatic allocation,
-- and canonical inactivity release. The WP01 message projection remains the
-- single source for needs_handling/pending_since/inactivity_expires_at.

INSERT INTO public.system_settings (key, value)
VALUES
  ('operator_heartbeat_stale_minutes', '2'::jsonb),
  ('operator_heartbeat_interval_seconds', '45'::jsonb),
  ('handling_allocation_target_seconds', '15'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

CREATE OR REPLACE FUNCTION private.finish_handling_cycle(
  _conversation_id uuid,
  _expected_operator_id uuid,
  _reason text,
  _event_at timestamptz DEFAULT clock_timestamp(),
  _expected_cycle_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation public.conversations%ROWTYPE;
  _cycle public.conversation_handling_cycles%ROWTYPE;
  _work_item public.conversation_work_items%ROWTYPE;
  _operator public.operators%ROWTYPE;
  _heartbeat_stale_minutes integer := GREATEST(private.setting_int('operator_heartbeat_stale_minutes', 5), 1);
  _inactivity_expired boolean := false;
  _operator_expired boolean := false;
  _requeued boolean := false;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  IF _reason NOT IN ('released', 'reassigned', 'timeout', 'closed') THEN
    RAISE EXCEPTION 'invalid_handling_end_reason';
  END IF;

  IF _reason = 'timeout' THEN
    IF _expected_operator_id IS NULL OR _expected_cycle_id IS NULL THEN
      RAISE EXCEPTION 'stale_handling_expectation_required';
    END IF;
  END IF;

  SELECT * INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  SELECT * INTO _cycle
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.conversation_id = _conversation_id
    AND cycle.ended_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'released', false,
      'conversation_id', _conversation_id,
      'reason', _reason,
      'requeued', false
    );
  END IF;

  IF _expected_cycle_id IS NOT NULL
     AND _cycle.id IS DISTINCT FROM _expected_cycle_id THEN
    RETURN jsonb_build_object(
      'released', false,
      'conversation_id', _conversation_id,
      'reason', _reason,
      'requeued', false,
      'stale_candidate', true
    );
  END IF;

  IF _expected_operator_id IS NOT NULL
     AND _cycle.operator_id IS DISTINCT FROM _expected_operator_id THEN
    RAISE EXCEPTION 'conversation_not_responsible_operator';
  END IF;

  SELECT * INTO _work_item
  FROM public.conversation_work_items work_item
  WHERE work_item.id = _cycle.work_item_id
  FOR UPDATE;

  SELECT * INTO _operator
  FROM public.operators operator
  WHERE operator.id = _cycle.operator_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'released', false,
      'conversation_id', _conversation_id,
      'reason', _reason,
      'requeued', false,
      'stale_candidate', true
    );
  END IF;

  IF _reason = 'timeout' THEN
    _inactivity_expired := _conversation.inactivity_expires_at IS NOT NULL
      AND _conversation.inactivity_expires_at <= _event_at;
    _operator_expired := _operator.is_active IS NOT TRUE
      OR _operator.deleted_at IS NOT NULL
      OR _operator.last_seen_at IS NULL
      OR _operator.last_seen_at < _event_at - make_interval(mins => _heartbeat_stale_minutes);

    IF NOT _inactivity_expired AND NOT _operator_expired THEN
      RETURN jsonb_build_object(
        'released', false,
        'conversation_id', _conversation_id,
        'cycle_id', _cycle.id,
        'reason', _reason,
        'requeued', false,
        'stale_candidate', true
      );
    END IF;
  END IF;

  UPDATE public.conversation_handling_cycles
  SET ended_at = _event_at,
      end_reason = _reason
  WHERE id = _cycle.id;

  UPDATE public.conversation_locks
  SET released_at = _event_at,
      released_by_user_id = CASE WHEN auth.uid() IS NOT NULL THEN auth.uid() ELSE released_by_user_id END,
      release_reason = CASE
        WHEN _reason = 'timeout' THEN 'heartbeat_timeout'
        ELSE _reason
      END
  WHERE conversation_id = _conversation_id
    AND locked_by_operator_id = _cycle.operator_id
    AND released_at IS NULL;

  UPDATE public.conversations
  SET assigned_operator_id = NULL,
      updated_at = clock_timestamp()
  WHERE id = _conversation_id
    AND assigned_operator_id = _cycle.operator_id;

  IF _reason = 'timeout' AND _operator_expired THEN
    UPDATE public.operators
    SET presence_status = 'offline'
    WHERE id = _operator.id;
  END IF;

  IF _work_item.id IS NOT NULL THEN
    IF _conversation.status = 'closed'::public.conversation_status THEN
      UPDATE public.conversation_work_items
      SET status = 'closed',
          responsible_operator_id = NULL,
          assigned_at = NULL,
          updated_at = clock_timestamp()
      WHERE id = _work_item.id;
    ELSIF _conversation.needs_handling IS TRUE THEN
      UPDATE public.conversation_work_items
      SET status = 'new',
          responsible_operator_id = NULL,
          assigned_at = NULL,
          last_activity_at = COALESCE(_conversation.pending_since, last_activity_at),
          updated_at = clock_timestamp()
      WHERE id = _work_item.id;
      _requeued := true;
    ELSE
      UPDATE public.conversation_work_items
      SET status = 'closed',
          responsible_operator_id = NULL,
          assigned_at = NULL,
          updated_at = clock_timestamp()
      WHERE id = _work_item.id;
    END IF;
  ELSIF _conversation.status <> 'closed'::public.conversation_status
        AND _conversation.needs_handling IS TRUE THEN
    INSERT INTO public.conversation_work_items (
      conversation_id, client_id, character_id, status,
      last_client_message_id, last_activity_at
    )
    SELECT
      _conversation.id,
      _conversation.client_id,
      _conversation.character_id,
      'new',
      message.id,
      COALESCE(_conversation.pending_since, message.created_at)
    FROM public.messages message
    WHERE message.conversation_id = _conversation.id
      AND message.sender_type = 'client'::public.sender_type
    ORDER BY message.handling_sequence DESC NULLS LAST, message.created_at DESC, message.id DESC
    LIMIT 1
    ON CONFLICT (conversation_id)
      WHERE status IN ('new', 'assigned', 'in_progress')
      DO UPDATE SET
        status = 'new',
        responsible_operator_id = NULL,
        assigned_at = NULL,
        last_client_message_id = EXCLUDED.last_client_message_id,
        last_activity_at = EXCLUDED.last_activity_at,
        updated_at = clock_timestamp();
    _requeued := true;
  END IF;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    auth.uid(),
    'conversation.handling_ended',
    'conversation',
    _conversation_id::text,
    jsonb_build_object(
      'cycle_id', _cycle.id,
      'operator_id', _cycle.operator_id,
      'reason', _reason,
      'timeout_cause', CASE
        WHEN _reason <> 'timeout' THEN NULL
        WHEN _inactivity_expired AND _operator_expired THEN 'inactivity_and_heartbeat'
        WHEN _inactivity_expired THEN 'inactivity'
        ELSE 'heartbeat'
      END,
      'needs_handling', _conversation.needs_handling,
      'requeued', _requeued
    )
  );

  RETURN jsonb_build_object(
    'released', true,
    'conversation_id', _conversation_id,
    'cycle_id', _cycle.id,
    'reason', _reason,
    'requeued', _requeued,
    'status', CASE WHEN _requeued THEN 'new' ELSE 'closed' END
  );
END;
$$;

REVOKE ALL ON FUNCTION private.finish_handling_cycle(uuid, uuid, text, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.return_stale_work_items_to_new(
  _fresh_operator_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _heartbeat_stale_minutes integer := GREATEST(private.setting_int('operator_heartbeat_stale_minutes', 5), 1);
  _scan_at timestamptz := clock_timestamp();
  _candidate_conversation_ids uuid[] := ARRAY[]::uuid[];
  _candidate record;
  _result jsonb;
  _released_count integer := 0;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();

  -- Row locks live until transaction end. Lock every conversation selected by
  -- this scan before finish_handling_cycle can lock any operator row, so a
  -- later candidate cannot invert Admin's conversation -> operator order.
  FOR _candidate IN
    SELECT conversation.id AS conversation_id
    FROM public.conversation_handling_cycles cycle
    JOIN public.conversations conversation ON conversation.id = cycle.conversation_id
    JOIN public.operators operator ON operator.id = cycle.operator_id
    WHERE cycle.ended_at IS NULL
      AND conversation.status <> 'closed'::public.conversation_status
      AND (
        conversation.inactivity_expires_at <= _scan_at
        OR (
          cycle.operator_id IS DISTINCT FROM _fresh_operator_id
          AND (
            operator.is_active IS NOT TRUE
            OR operator.deleted_at IS NOT NULL
            OR operator.last_seen_at IS NULL
            OR operator.last_seen_at < _scan_at - make_interval(mins => _heartbeat_stale_minutes)
          )
        )
      )
    ORDER BY conversation.id
    FOR UPDATE OF conversation
  LOOP
    _candidate_conversation_ids := array_append(
      _candidate_conversation_ids,
      _candidate.conversation_id
    );
  END LOOP;

  FOR _candidate IN
    SELECT
      cycle.conversation_id,
      cycle.id AS cycle_id,
      cycle.operator_id,
      conversation.inactivity_expires_at,
      operator.last_seen_at,
      operator.is_active,
      operator.deleted_at
    FROM public.conversation_handling_cycles cycle
    JOIN public.conversations conversation ON conversation.id = cycle.conversation_id
    JOIN public.operators operator ON operator.id = cycle.operator_id
    WHERE conversation.id = ANY (_candidate_conversation_ids)
      AND cycle.ended_at IS NULL
      AND conversation.status <> 'closed'::public.conversation_status
      AND (
        conversation.inactivity_expires_at <= _scan_at
        OR (
          cycle.operator_id IS DISTINCT FROM _fresh_operator_id
          AND (
            operator.is_active IS NOT TRUE
            OR operator.deleted_at IS NOT NULL
            OR operator.last_seen_at IS NULL
            OR operator.last_seen_at < _scan_at - make_interval(mins => _heartbeat_stale_minutes)
          )
        )
      )
    ORDER BY conversation.id
  LOOP
    _result := private.finish_handling_cycle(
      _candidate.conversation_id,
      _candidate.operator_id,
      'timeout',
      clock_timestamp(),
      _candidate.cycle_id
    );

    IF COALESCE((_result->>'released')::boolean, false) THEN
      _released_count := _released_count + 1;
    END IF;

  END LOOP;

  RETURN _released_count;
END;
$$;

CREATE OR REPLACE FUNCTION private.return_stale_work_items_to_new()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT private.return_stale_work_items_to_new(NULL::uuid);
$$;

REVOKE ALL ON FUNCTION private.return_stale_work_items_to_new(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

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

REVOKE ALL ON FUNCTION private.allocate_new_conversations(integer, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.run_handling_allocation(_max_assignments integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _released integer;
  _allocated integer;
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  _released := private.return_stale_work_items_to_new();
  _allocated := private.allocate_new_conversations(_max_assignments);

  RETURN jsonb_build_object('released', _released, 'allocated', _allocated);
END;
$$;

REVOKE ALL ON FUNCTION public.run_handling_allocation(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_handling_allocation(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.operator_heartbeat()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _operator_id uuid;
  _returned_count integer;
  _allocated_count integer;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT operator.id INTO _operator_id
  FROM public.operators operator
  WHERE operator.user_id = _user_id
    AND operator.is_active IS TRUE
    AND operator.deleted_at IS NULL;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  _returned_count := private.return_stale_work_items_to_new(_operator_id);
  _allocated_count := private.allocate_new_conversations(50, _operator_id);

  UPDATE public.operators
  SET last_seen_at = clock_timestamp(),
      presence_status = 'online'
  WHERE id = _operator_id
    AND user_id = _user_id
    AND is_active IS TRUE
    AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'operator_record_required'; END IF;

  RETURN jsonb_build_object(
    'operator_id', _operator_id,
    'presence_status', 'online',
    'returned_stale_work_items', _returned_count,
    'allocated_work_items', _allocated_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_operator_conversation(
  _conversation_id uuid,
  _reason text DEFAULT 'released'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _guard record;
  _release_reason text := COALESCE(NULLIF(btrim(_reason), ''), 'released');
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _release_reason NOT IN ('released', 'reassigned') THEN
    RAISE EXCEPTION 'invalid_release_reason';
  END IF;

  SELECT * INTO _guard
  FROM private.assert_operator_can_send_base(_conversation_id);

  RETURN private.finish_handling_cycle(
    _conversation_id,
    _guard.operator_id,
    _release_reason,
    clock_timestamp(),
    NULL
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.acquire_operator_send_authority(
  _conversation_id uuid,
  _expected_cycle_id uuid
)
RETURNS TABLE(
  operator_id uuid,
  user_id uuid,
  handling_cycle_id uuid,
  work_item_id uuid,
  authority_source text,
  claimed_now boolean,
  concurrency_mode text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _guard record;
  _conversation public.conversations%ROWTYPE;
  _cycle public.conversation_handling_cycles%ROWTYPE;
  _work_item public.conversation_work_items%ROWTYPE;
  _operator public.operators%ROWTYPE;
  _active_cycle_count integer;
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF public.is_admin() IS TRUE THEN RAISE EXCEPTION 'admin_takeover_required'; END IF;

  SELECT * INTO _guard
  FROM private.assert_operator_can_send_base(_conversation_id);

  SELECT * INTO _conversation
  FROM public.conversations conversation
  WHERE conversation.id = _conversation_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.operator_client_blocks block
    WHERE block.operator_id = _guard.operator_id AND block.client_id = _conversation.client_id
  ) THEN RAISE EXCEPTION 'client_blocked_by_operator'; END IF;

  SELECT * INTO _cycle
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.conversation_id = _conversation_id AND cycle.ended_at IS NULL
  FOR UPDATE;

  IF FOUND THEN
    IF _expected_cycle_id IS NULL OR _expected_cycle_id IS DISTINCT FROM _cycle.id THEN
      RAISE EXCEPTION 'handling_cycle_token_invalid';
    END IF;
    IF _cycle.operator_id IS DISTINCT FROM _guard.operator_id THEN
      RAISE EXCEPTION 'conversation_not_responsible_operator';
    END IF;
    IF _conversation.inactivity_expires_at IS NULL
       OR _conversation.inactivity_expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'handling_cycle_expired';
    END IF;

    SELECT * INTO _work_item FROM public.conversation_work_items work_item
    WHERE work_item.id = _cycle.work_item_id FOR UPDATE;
    IF NOT FOUND
      OR _work_item.conversation_id IS DISTINCT FROM _conversation_id
      OR _work_item.responsible_operator_id IS DISTINCT FROM _guard.operator_id
      OR _work_item.status NOT IN ('assigned', 'in_progress')
      OR _conversation.assigned_operator_id IS DISTINCT FROM _guard.operator_id
    THEN RAISE EXCEPTION 'conversation_claim_state_inconsistent'; END IF;

    SELECT * INTO _operator
    FROM public.operators operator
    WHERE operator.id = _guard.operator_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'operator_record_required'; END IF;

    RETURN QUERY SELECT _guard.operator_id, _guard.user_id, _cycle.id, _work_item.id,
      'cycle_token'::text, false, _guard.concurrency_mode;
    RETURN;
  END IF;

  IF _expected_cycle_id IS NOT NULL THEN RAISE EXCEPTION 'handling_cycle_token_invalid'; END IF;
  IF _conversation.needs_handling IS NOT TRUE OR _conversation.pending_since IS NULL THEN
    RAISE EXCEPTION 'conversation_not_available_for_claim';
  END IF;
  IF _conversation.inactivity_expires_at IS NULL
     OR _conversation.inactivity_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'conversation_claim_state_expired';
  END IF;

  SELECT * INTO _work_item FROM public.conversation_work_items work_item
  WHERE work_item.conversation_id = _conversation_id
    AND work_item.status = 'new'
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_available_for_claim'; END IF;

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

  SELECT count(*)::integer INTO _active_cycle_count
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.operator_id = _guard.operator_id AND cycle.ended_at IS NULL;
  IF _active_cycle_count >= 5 THEN RAISE EXCEPTION 'operator_capacity_reached'; END IF;

  UPDATE public.conversation_work_items
  SET status = 'assigned', responsible_operator_id = _guard.operator_id,
      assigned_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE id = _work_item.id
  RETURNING * INTO _work_item;

  UPDATE public.conversations
  SET assigned_operator_id = _guard.operator_id, updated_at = clock_timestamp()
  WHERE id = _conversation_id AND assigned_operator_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_already_claimed'; END IF;

  INSERT INTO public.conversation_handling_cycles (conversation_id, work_item_id, operator_id)
  VALUES (_conversation_id, _work_item.id, _guard.operator_id)
  RETURNING * INTO _cycle;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (
    _guard.user_id,
    'conversation.claimed_on_send',
    'conversation',
    _conversation_id::text,
    jsonb_build_object('operator_id', _guard.operator_id, 'cycle_id', _cycle.id)
  );

  RETURN QUERY SELECT _guard.operator_id, _guard.user_id, _cycle.id, _work_item.id,
    'atomic_claim_and_send'::text, true, _guard.concurrency_mode;
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

CREATE OR REPLACE FUNCTION public.admin_reassign_conversation(
  _conversation_id uuid,
  _operator_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'admin_transfer_reason_required';
END;
$$;

CREATE OR REPLACE FUNCTION public.get_operator_new_queue()
RETURNS TABLE (
  work_item_id uuid,
  conversation_id uuid,
  character_id uuid,
  status text,
  queue_state text,
  client_display_name text,
  character_name text,
  character_avatar_url text,
  last_client_preview text,
  last_activity_at timestamptz,
  created_at timestamptz,
  wait_seconds integer,
  sla_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _operator_id uuid;
BEGIN
  IF _user_id IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  SELECT operator.id INTO _operator_id
  FROM public.operators operator
  WHERE operator.user_id = _user_id AND operator.is_active IS TRUE AND operator.deleted_at IS NULL;
  IF _operator_id IS NULL THEN RAISE EXCEPTION 'operator_record_required'; END IF;

  RETURN QUERY
  SELECT
    work_item.id,
    work_item.conversation_id,
    work_item.character_id,
    work_item.status,
    CASE
      WHEN work_item.responsible_operator_id = _operator_id THEN 'assigned'
      WHEN last_cycle.end_reason IN ('released', 'reassigned', 'timeout') THEN 'returned'
      ELSE 'new'
    END,
    profile.display_name,
    character.name,
    character.avatar_url,
    COALESCE(client_message.content, conversation.last_message_preview, ''),
    COALESCE(conversation.pending_since, work_item.last_activity_at),
    work_item.created_at,
    GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - conversation.pending_since)))::integer),
    CASE
      WHEN clock_timestamp() - conversation.pending_since >= interval '15 minutes' THEN 'critical'
      WHEN clock_timestamp() - conversation.pending_since >= interval '5 minutes' THEN 'warning'
      ELSE 'normal'
    END
  FROM public.conversation_work_items work_item
  JOIN public.conversations conversation ON conversation.id = work_item.conversation_id
  JOIN public.characters character ON character.id = work_item.character_id
  JOIN public.messages client_message ON client_message.id = work_item.last_client_message_id
  JOIN public.profiles profile ON profile.user_id = work_item.client_id
  LEFT JOIN LATERAL (
    SELECT cycle.end_reason
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.work_item_id = work_item.id AND cycle.ended_at IS NOT NULL
    ORDER BY cycle.ended_at DESC LIMIT 1
  ) last_cycle ON true
  WHERE conversation.needs_handling IS TRUE
    AND conversation.pending_since IS NOT NULL
    AND conversation.status <> 'closed'::public.conversation_status
    AND profile.status = 'active'
    AND profile.deleted_at IS NULL
    AND profile.pii_archived_at IS NULL
    AND (
      (
        work_item.status = 'new'
        AND conversation.assigned_operator_id IS NULL
        AND EXISTS (
          SELECT 1 FROM public.character_operator_assignments assignment
          WHERE assignment.character_id = work_item.character_id
            AND assignment.operator_id = _operator_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.operator_client_blocks block
          WHERE block.operator_id = _operator_id AND block.client_id = work_item.client_id
        )
      )
      OR (
        work_item.status IN ('assigned', 'in_progress')
        AND work_item.responsible_operator_id = _operator_id
        AND conversation.assigned_operator_id = _operator_id
      )
    )
  ORDER BY conversation.pending_since ASC, work_item.id ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_operator_new_sla_summary()
RETURNS TABLE (
  total_new integer,
  warning_count integer,
  critical_count integer,
  oldest_wait_seconds integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE queue.wait_seconds >= 300)::integer,
    count(*) FILTER (WHERE queue.wait_seconds >= 900)::integer,
    COALESCE(max(queue.wait_seconds), 0)::integer
  FROM public.get_operator_new_queue() queue
  WHERE queue.status = 'new';
$$;

CREATE OR REPLACE FUNCTION public.get_admin_new_sla_summary()
RETURNS TABLE (
  character_id uuid,
  character_name text,
  total_new integer,
  warning_count integer,
  critical_count integer,
  oldest_wait_seconds integer,
  eligible_operator_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'admin_required'; END IF;
  RETURN QUERY
  SELECT
    work_item.character_id,
    character.name,
    count(*)::integer,
    count(*) FILTER (WHERE clock_timestamp() - conversation.pending_since >= interval '5 minutes')::integer,
    count(*) FILTER (WHERE clock_timestamp() - conversation.pending_since >= interval '15 minutes')::integer,
    COALESCE(max(GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - conversation.pending_since)))::integer)), 0)::integer,
    (
      SELECT count(*)::integer
      FROM public.character_operator_assignments assignment
      JOIN public.operators operator ON operator.id = assignment.operator_id
      WHERE assignment.character_id = work_item.character_id
        AND operator.is_active IS TRUE
        AND operator.deleted_at IS NULL
        AND operator.availability_status = 'available'::public.availability_status
        AND operator.presence_status = 'online'
        AND operator.last_seen_at >= clock_timestamp() - make_interval(mins => GREATEST(private.setting_int('operator_heartbeat_stale_minutes', 5), 1))
        AND (
          SELECT count(*) FROM public.conversation_handling_cycles cycle
          WHERE cycle.operator_id = operator.id AND cycle.ended_at IS NULL
        ) < 5
    )
  FROM public.conversation_work_items work_item
  JOIN public.conversations conversation ON conversation.id = work_item.conversation_id
  JOIN public.characters character ON character.id = work_item.character_id
  JOIN public.profiles profile ON profile.user_id = work_item.client_id
  WHERE work_item.status = 'new'
    AND conversation.assigned_operator_id IS NULL
    AND conversation.needs_handling IS TRUE
    AND conversation.pending_since IS NOT NULL
    AND conversation.status <> 'closed'::public.conversation_status
    AND profile.status = 'active'
    AND profile.deleted_at IS NULL
    AND profile.pii_archived_at IS NULL
  GROUP BY work_item.character_id, character.name
  ORDER BY min(conversation.pending_since) ASC, character.name;
END;
$$;

REVOKE ALL ON FUNCTION public.operator_heartbeat() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.release_operator_conversation(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_new_conversation(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_reassign_conversation(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_reassign_conversation(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_operator_new_queue() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_operator_new_sla_summary() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admin_new_sla_summary() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.operator_heartbeat() TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_operator_conversation(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_new_conversation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reassign_conversation(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reassign_conversation(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_operator_new_queue() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_operator_new_sla_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_new_sla_summary() TO authenticated;

NOTIFY pgrst, 'reload schema';

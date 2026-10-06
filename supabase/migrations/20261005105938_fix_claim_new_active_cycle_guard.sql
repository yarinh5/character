-- Sending requires the current handling-cycle owner. Claiming must retain its
-- established status-based competing-claim result before ownership exists.
CREATE OR REPLACE FUNCTION private.assert_operator_can_send_conversation_message(
  _conversation_id UUID,
  _require_active_cycle_ownership BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
  operator_id UUID,
  user_id UUID,
  concurrency_mode TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _operator_id UUID;
  _conversation public.conversations%ROWTYPE;
  _active_lock public.conversation_locks%ROWTYPE;
  _concurrency_mode TEXT := COALESCE(private.setting_text('concurrency_mode', 'open'), 'open');
  _timeout_minutes INTEGER := GREATEST(private.setting_int('lock_timeout_minutes', 10), 1);
  _acquire_result JSONB;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM public.cleanup_expired_conversation_locks();

  SELECT o.id
  INTO _operator_id
  FROM public.operators o
  WHERE o.user_id = _user_id
    AND o.is_active = true
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations c
  WHERE c.id = _conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF _conversation.status = 'closed'::public.conversation_status THEN
    RAISE EXCEPTION 'conversation_closed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.character_operator_assignments coa
    WHERE coa.character_id = _conversation.character_id
      AND coa.operator_id = _operator_id
  ) THEN
    RAISE EXCEPTION 'operator_not_assigned_to_character';
  END IF;

  IF _require_active_cycle_ownership AND EXISTS (
    SELECT 1
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.conversation_id = _conversation_id
      AND cycle.ended_at IS NULL
      AND cycle.operator_id IS DISTINCT FROM _operator_id
  ) THEN
    RAISE EXCEPTION 'conversation_not_responsible_operator';
  END IF;

  IF _concurrency_mode = 'lock' THEN
    SELECT *
    INTO _active_lock
    FROM public.conversation_locks l
    WHERE l.conversation_id = _conversation_id
      AND l.released_at IS NULL
      AND l.expires_at > clock_timestamp()
    FOR UPDATE;

    IF FOUND AND _active_lock.locked_by_operator_id <> _operator_id THEN
      RAISE EXCEPTION 'conversation_locked_by_other_operator';
    END IF;

    IF NOT FOUND THEN
      _acquire_result := public.acquire_conversation_lock(_conversation_id);
      IF COALESCE((_acquire_result->>'acquired')::BOOLEAN, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'conversation_locked_by_other_operator';
      END IF;
    ELSE
      UPDATE public.conversation_locks
      SET
        last_activity_at = clock_timestamp(),
        expires_at = clock_timestamp() + make_interval(mins => _timeout_minutes)
      WHERE conversation_id = _conversation_id;
    END IF;
  ELSIF _concurrency_mode = 'warning' THEN
    _acquire_result := public.acquire_conversation_lock(_conversation_id);
  END IF;

  RETURN QUERY SELECT _operator_id, _user_id, _concurrency_mode;
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
  FROM private.assert_operator_can_send_conversation_message(_conversation_id, FALSE);

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

NOTIFY pgrst, 'reload schema';

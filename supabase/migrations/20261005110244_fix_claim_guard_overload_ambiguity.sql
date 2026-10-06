-- Keep the one-argument send guard unambiguous for all existing send paths.
-- The two-argument claim variant is intentionally explicit and has no default.
DROP FUNCTION private.assert_operator_can_send_conversation_message(UUID, BOOLEAN);

CREATE OR REPLACE FUNCTION private.assert_operator_can_send_conversation_message(
  _conversation_id UUID,
  _require_active_cycle_ownership BOOLEAN
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

NOTIFY pgrst, 'reload schema';

-- V2-13: a stale handling cycle must not hide a fresh client message from NEW.
--
-- The NEW model remains "free conversations only": a recently claimed
-- conversation is still hidden. This fix only times out old handling cycles
-- before routing a new client message, so a forgotten/legacy cycle cannot keep
-- future client work invisible.

CREATE OR REPLACE FUNCTION private.upsert_conversation_work_item_from_client_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation public.conversations%ROWTYPE;
  _active_operator_id UUID;
  _active_started_at TIMESTAMPTZ;
  _stale_cycle RECORD;
  _stale_minutes INTEGER := GREATEST(
    private.setting_int(
      'operator_handling_cycle_stale_minutes',
      private.setting_int('operator_heartbeat_stale_minutes', 5)
    ),
    1
  );
BEGIN
  IF NEW.sender_type <> 'client'::public.sender_type THEN
    RETURN NEW;
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations
  WHERE id = NEW.conversation_id;

  IF NOT FOUND OR _conversation.status = 'closed'::public.conversation_status THEN
    RETURN NEW;
  END IF;

  FOR _stale_cycle IN
    SELECT
      cycle.id AS cycle_id,
      cycle.work_item_id,
      cycle.operator_id
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.conversation_id = _conversation.id
      AND cycle.ended_at IS NULL
      AND cycle.started_at < NEW.created_at - make_interval(mins => _stale_minutes)
    FOR UPDATE OF cycle
  LOOP
    UPDATE public.conversation_handling_cycles
    SET ended_at = NEW.created_at,
        end_reason = 'timeout'
    WHERE id = _stale_cycle.cycle_id
      AND ended_at IS NULL;

    UPDATE public.conversation_locks
    SET released_at = NEW.created_at,
        released_by_user_id = NULL,
        release_reason = 'heartbeat_timeout'
    WHERE conversation_id = _conversation.id
      AND locked_by_operator_id = _stale_cycle.operator_id
      AND released_at IS NULL;

    UPDATE public.conversations
    SET assigned_operator_id = NULL,
        updated_at = clock_timestamp()
    WHERE id = _conversation.id
      AND assigned_operator_id = _stale_cycle.operator_id;

    UPDATE public.conversation_work_items
    SET status = 'new',
        responsible_operator_id = NULL,
        assigned_at = NULL,
        last_activity_at = GREATEST(last_activity_at, NEW.created_at)
    WHERE id = _stale_cycle.work_item_id
      AND status IN ('assigned', 'in_progress');
  END LOOP;

  SELECT cycle.operator_id, cycle.started_at
  INTO _active_operator_id, _active_started_at
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.conversation_id = _conversation.id
    AND cycle.ended_at IS NULL
  ORDER BY cycle.started_at DESC
  LIMIT 1;

  INSERT INTO public.conversation_work_items (
    conversation_id,
    client_id,
    character_id,
    status,
    responsible_operator_id,
    assigned_at,
    last_client_message_id,
    last_activity_at
  )
  VALUES (
    _conversation.id,
    _conversation.client_id,
    _conversation.character_id,
    CASE WHEN _active_operator_id IS NULL THEN 'new' ELSE 'in_progress' END,
    _active_operator_id,
    CASE WHEN _active_operator_id IS NULL THEN NULL ELSE _active_started_at END,
    NEW.id,
    NEW.created_at
  )
  ON CONFLICT (conversation_id)
  WHERE status IN ('new', 'assigned', 'in_progress')
  DO UPDATE SET
    last_client_message_id = CASE
      WHEN EXCLUDED.last_activity_at >= public.conversation_work_items.last_activity_at
        THEN EXCLUDED.last_client_message_id
      ELSE public.conversation_work_items.last_client_message_id
    END,
    last_activity_at = GREATEST(
      public.conversation_work_items.last_activity_at,
      EXCLUDED.last_activity_at
    ),
    status = CASE WHEN _active_operator_id IS NULL THEN 'new' ELSE 'in_progress' END,
    responsible_operator_id = _active_operator_id,
    assigned_at = CASE WHEN _active_operator_id IS NULL THEN NULL ELSE _active_started_at END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.upsert_conversation_work_item_from_client_message()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.upsert_conversation_work_item_from_client_message()
  TO service_role;

-- Normalize existing hidden work caused by stale cycles. Only conversations
-- whose latest message is a client message are returned to NEW.
WITH stale_cycles AS (
  SELECT
    cycle.id AS cycle_id,
    cycle.work_item_id,
    cycle.conversation_id,
    cycle.operator_id,
    latest_message.id AS latest_message_id,
    latest_message.created_at AS latest_message_at
  FROM public.conversation_handling_cycles cycle
  JOIN public.conversation_work_items wi ON wi.id = cycle.work_item_id
  JOIN public.conversations c ON c.id = cycle.conversation_id
  JOIN LATERAL (
    SELECT m.id, m.created_at, m.sender_type
    FROM public.messages m
    WHERE m.conversation_id = cycle.conversation_id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ) latest_message ON true
  WHERE cycle.ended_at IS NULL
    AND wi.status IN ('assigned', 'in_progress')
    AND c.status <> 'closed'::public.conversation_status
    AND latest_message.sender_type = 'client'::public.sender_type
    AND cycle.started_at < latest_message.created_at - make_interval(
      mins => GREATEST(
        private.setting_int(
          'operator_handling_cycle_stale_minutes',
          private.setting_int('operator_heartbeat_stale_minutes', 5)
        ),
        1
      )
    )
),
closed_cycles AS (
  UPDATE public.conversation_handling_cycles cycle
  SET ended_at = stale_cycles.latest_message_at,
      end_reason = 'timeout'
  FROM stale_cycles
  WHERE cycle.id = stale_cycles.cycle_id
    AND cycle.ended_at IS NULL
  RETURNING
    stale_cycles.work_item_id,
    stale_cycles.conversation_id,
    stale_cycles.operator_id,
    stale_cycles.latest_message_id,
    stale_cycles.latest_message_at
),
released_locks AS (
  UPDATE public.conversation_locks lock
  SET released_at = closed_cycles.latest_message_at,
      released_by_user_id = NULL,
      release_reason = 'heartbeat_timeout'
  FROM closed_cycles
  WHERE lock.conversation_id = closed_cycles.conversation_id
    AND lock.locked_by_operator_id = closed_cycles.operator_id
    AND lock.released_at IS NULL
  RETURNING lock.conversation_id
),
cleared_conversations AS (
  UPDATE public.conversations c
  SET assigned_operator_id = NULL,
      updated_at = clock_timestamp()
  FROM closed_cycles
  WHERE c.id = closed_cycles.conversation_id
    AND c.assigned_operator_id = closed_cycles.operator_id
  RETURNING c.id
)
UPDATE public.conversation_work_items wi
SET status = 'new',
    responsible_operator_id = NULL,
    assigned_at = NULL,
    last_client_message_id = closed_cycles.latest_message_id,
    last_activity_at = GREATEST(wi.last_activity_at, closed_cycles.latest_message_at)
FROM closed_cycles
WHERE wi.id = closed_cycles.work_item_id
  AND wi.status IN ('assigned', 'in_progress');

NOTIFY pgrst, 'reload schema';

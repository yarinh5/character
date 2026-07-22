-- V2-7: legacy assigned_operator_id is not handling ownership. Only an active
-- handling cycle or an unexpired conversation lock keeps client work out of NEW.

CREATE OR REPLACE FUNCTION private.upsert_conversation_work_item_from_client_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation public.conversations%ROWTYPE;
  _active_cycle RECORD;
  _active_lock RECORD;
  _handling_operator_id UUID;
  _handling_started_at TIMESTAMPTZ;
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

  SELECT cycle.operator_id, cycle.started_at
  INTO _active_cycle
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.conversation_id = _conversation.id
    AND cycle.ended_at IS NULL
  ORDER BY cycle.started_at DESC
  LIMIT 1;

  SELECT lock.locked_by_operator_id, lock.locked_at
  INTO _active_lock
  FROM public.conversation_locks lock
  WHERE lock.conversation_id = _conversation.id
    AND lock.released_at IS NULL
    AND lock.expires_at > clock_timestamp()
  LIMIT 1;

  _handling_operator_id := COALESCE(_active_cycle.operator_id, _active_lock.locked_by_operator_id);
  _handling_started_at := COALESCE(_active_cycle.started_at, _active_lock.locked_at, NEW.created_at);

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
    CASE
      WHEN _handling_operator_id IS NULL THEN 'new'
      ELSE 'in_progress'
    END,
    _handling_operator_id,
    CASE
      WHEN _handling_operator_id IS NULL THEN NULL
      ELSE _handling_started_at
    END,
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
    status = CASE
      WHEN public.conversation_work_items.status = 'assigned'
        OR (
          public.conversation_work_items.status = 'new'
          AND _handling_operator_id IS NOT NULL
        )
        THEN 'in_progress'
      ELSE public.conversation_work_items.status
    END,
    responsible_operator_id = CASE
      WHEN public.conversation_work_items.status = 'new'
        AND _handling_operator_id IS NOT NULL
        THEN _handling_operator_id
      ELSE public.conversation_work_items.responsible_operator_id
    END,
    assigned_at = CASE
      WHEN public.conversation_work_items.status = 'new'
        AND _handling_operator_id IS NOT NULL
        THEN _handling_started_at
      ELSE public.conversation_work_items.assigned_at
    END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.upsert_conversation_work_item_from_client_message()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.upsert_conversation_work_item_from_client_message()
  TO service_role;

-- Requeue work items that V2-6 marked as in progress using only legacy assignment.
UPDATE public.conversation_work_items wi
SET status = 'new',
    responsible_operator_id = NULL,
    assigned_at = NULL
FROM public.conversations c
WHERE c.id = wi.conversation_id
  AND c.status <> 'closed'::public.conversation_status
  AND wi.status IN ('assigned', 'in_progress')
  AND NOT EXISTS (
    SELECT 1
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.work_item_id = wi.id
      AND cycle.ended_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.conversation_locks lock
    WHERE lock.conversation_id = wi.conversation_id
      AND lock.released_at IS NULL
      AND lock.expires_at > clock_timestamp()
  );

-- A genuine legacy lock/cycle is still handling context, even if its work item
-- was previously left in NEW.
WITH handling_context AS (
  SELECT
    wi.id AS work_item_id,
    active_cycle.operator_id AS cycle_operator_id,
    active_cycle.started_at AS cycle_started_at,
    active_lock.locked_by_operator_id AS lock_operator_id,
    active_lock.locked_at
  FROM public.conversation_work_items wi
  LEFT JOIN LATERAL (
    SELECT cycle.operator_id, cycle.started_at
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.work_item_id = wi.id
      AND cycle.ended_at IS NULL
    ORDER BY cycle.started_at DESC
    LIMIT 1
  ) active_cycle ON true
  LEFT JOIN LATERAL (
    SELECT lock.locked_by_operator_id, lock.locked_at
    FROM public.conversation_locks lock
    WHERE lock.conversation_id = wi.conversation_id
      AND lock.released_at IS NULL
      AND lock.expires_at > clock_timestamp()
    LIMIT 1
  ) active_lock ON true
)
UPDATE public.conversation_work_items wi
SET status = 'in_progress',
    responsible_operator_id = COALESCE(context.cycle_operator_id, context.lock_operator_id),
    assigned_at = COALESCE(context.cycle_started_at, context.locked_at, wi.assigned_at, wi.created_at)
FROM public.conversations c,
     handling_context context
WHERE context.work_item_id = wi.id
  AND c.id = wi.conversation_id
  AND c.status <> 'closed'::public.conversation_status
  AND wi.status = 'new'
  AND COALESCE(context.cycle_operator_id, context.lock_operator_id) IS NOT NULL;

NOTIFY pgrst, 'reload schema';

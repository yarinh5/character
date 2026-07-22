-- V2-8: only a real active handling cycle removes client work from NEW.
-- Conversation locks remain claim guards, but never define queue ownership.

CREATE OR REPLACE FUNCTION private.upsert_conversation_work_item_from_client_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation public.conversations%ROWTYPE;
  _active_cycle RECORD;
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
    CASE WHEN _active_cycle.operator_id IS NULL THEN 'new' ELSE 'in_progress' END,
    _active_cycle.operator_id,
    CASE WHEN _active_cycle.operator_id IS NULL THEN NULL ELSE _active_cycle.started_at END,
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
      WHEN _active_cycle.operator_id IS NULL THEN 'new'
      ELSE 'in_progress'
    END,
    responsible_operator_id = _active_cycle.operator_id,
    assigned_at = CASE
      WHEN _active_cycle.operator_id IS NULL THEN NULL
      ELSE _active_cycle.started_at
    END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.upsert_conversation_work_item_from_client_message()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.upsert_conversation_work_item_from_client_message()
  TO service_role;

-- Requeue legacy lock-only assignments. A lock never proves that NEW was claimed.
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
  );

-- Preserve real handling ownership if a prior migration left its work item in NEW.
WITH active_cycles AS (
  SELECT DISTINCT ON (cycle.work_item_id)
    cycle.work_item_id,
    cycle.operator_id,
    cycle.started_at
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.ended_at IS NULL
  ORDER BY cycle.work_item_id, cycle.started_at DESC
)
UPDATE public.conversation_work_items wi
SET status = 'in_progress',
    responsible_operator_id = active_cycle.operator_id,
    assigned_at = active_cycle.started_at
FROM public.conversations c
   , active_cycles active_cycle
WHERE c.id = wi.conversation_id
  AND active_cycle.work_item_id = wi.id
  AND c.status <> 'closed'::public.conversation_status
  AND wi.status = 'new';

NOTIFY pgrst, 'reload schema';

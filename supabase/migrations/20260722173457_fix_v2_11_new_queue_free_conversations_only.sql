-- V2-11: NEW is a queue of free conversations only. Handling cycles own a
-- conversation until release, timeout, or closure.

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
    status = CASE WHEN _active_cycle.operator_id IS NULL THEN 'new' ELSE 'in_progress' END,
    responsible_operator_id = _active_cycle.operator_id,
    assigned_at = CASE WHEN _active_cycle.operator_id IS NULL THEN NULL ELSE _active_cycle.started_at END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.upsert_conversation_work_item_from_client_message()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.upsert_conversation_work_item_from_client_message()
  TO service_role;

-- First restore ownership for every real active handling cycle.
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
FROM active_cycles active_cycle
WHERE active_cycle.work_item_id = wi.id
  AND wi.status IN ('new', 'assigned', 'in_progress');

-- Any active work item without a handling cycle is free work and belongs in NEW.
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
    AND o.is_active = true
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
  ) last_cycle ON true
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
      FROM public.character_operator_assignments coa
      WHERE coa.character_id = wi.character_id
        AND coa.operator_id = _operator_id
    )
  ORDER BY wi.last_activity_at DESC, wi.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_operator_new_queue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operator_new_queue() TO authenticated;

NOTIFY pgrst, 'reload schema';

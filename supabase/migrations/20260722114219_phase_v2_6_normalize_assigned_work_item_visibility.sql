-- Phase V2-6: client activity must preserve an existing handling assignment.

CREATE OR REPLACE FUNCTION private.upsert_conversation_work_item_from_client_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _conversation public.conversations%ROWTYPE;
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
      WHEN _conversation.assigned_operator_id IS NULL THEN 'new'
      ELSE 'in_progress'
    END,
    _conversation.assigned_operator_id,
    CASE
      WHEN _conversation.assigned_operator_id IS NULL THEN NULL
      ELSE COALESCE(_conversation.updated_at, NEW.created_at)
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
      WHEN public.conversation_work_items.status = 'assigned' THEN 'in_progress'
      ELSE public.conversation_work_items.status
    END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.upsert_conversation_work_item_from_client_message()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.upsert_conversation_work_item_from_client_message()
  TO service_role;

-- Existing assigned conversations are handling context, not NEW work. Preserve the
-- latest client activity when available without fabricating a new assignment.
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
SELECT
  c.id,
  c.client_id,
  c.character_id,
  'in_progress',
  c.assigned_operator_id,
  COALESCE(c.updated_at, c.created_at),
  last_client_message.id,
  COALESCE(last_client_message.created_at, c.updated_at, c.created_at)
FROM public.conversations c
LEFT JOIN LATERAL (
  SELECT m.id, m.created_at
  FROM public.messages m
  WHERE m.conversation_id = c.id
    AND m.sender_type = 'client'::public.sender_type
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1
) last_client_message ON true
WHERE c.status <> 'closed'::public.conversation_status
  AND c.assigned_operator_id IS NOT NULL
ON CONFLICT (conversation_id)
WHERE status IN ('new', 'assigned', 'in_progress')
DO NOTHING;

-- Unassigned conversations only enter NEW when their latest message is from the client.
INSERT INTO public.conversation_work_items (
  conversation_id,
  client_id,
  character_id,
  status,
  last_client_message_id,
  last_activity_at
)
SELECT
  c.id,
  c.client_id,
  c.character_id,
  'new',
  latest_message.id,
  latest_message.created_at
FROM public.conversations c
JOIN LATERAL (
  SELECT m.id, m.created_at, m.sender_type
  FROM public.messages m
  WHERE m.conversation_id = c.id
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 1
) latest_message ON true
WHERE c.status <> 'closed'::public.conversation_status
  AND c.assigned_operator_id IS NULL
  AND latest_message.sender_type = 'client'::public.sender_type
ON CONFLICT (conversation_id)
WHERE status IN ('new', 'assigned', 'in_progress')
DO NOTHING;

NOTIFY pgrst, 'reload schema';

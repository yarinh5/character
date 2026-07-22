-- V2-10: NEW tracks unanswered client messages, not only unclaimed work items.

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
        AND COALESCE(client_message.created_at, wi.created_at) <= last_cycle.ended_at THEN 'returned'
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
    SELECT cycle.operator_id
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.work_item_id = wi.id
      AND cycle.ended_at IS NULL
    ORDER BY cycle.started_at DESC
    LIMIT 1
  ) active_cycle ON true
  LEFT JOIN LATERAL (
    SELECT cycle.end_reason, cycle.ended_at
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.work_item_id = wi.id
      AND cycle.ended_at IS NOT NULL
    ORDER BY cycle.ended_at DESC
    LIMIT 1
  ) last_cycle ON true
  WHERE wi.status IN ('new', 'assigned', 'in_progress')
    AND c.status <> 'closed'::public.conversation_status
    AND client_message.sender_type = 'client'::public.sender_type
    AND NOT EXISTS (
      SELECT 1
      FROM public.messages reply
      WHERE reply.conversation_id = wi.conversation_id
        AND reply.sender_type = ANY (ARRAY['operator', 'admin']::public.sender_type[])
        AND reply.created_at > client_message.created_at
    )
    AND EXISTS (
      SELECT 1
      FROM public.character_operator_assignments coa
      WHERE coa.character_id = wi.character_id
        AND coa.operator_id = _operator_id
    )
    AND (active_cycle.operator_id IS NULL OR active_cycle.operator_id = _operator_id)
  ORDER BY wi.last_activity_at DESC, wi.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_operator_new_queue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operator_new_queue() TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Phase V2-3: expose only queue-safe presentation state for the operator NEW view.

CREATE INDEX conversation_handling_cycles_work_item_ended_idx
  ON public.conversation_handling_cycles (work_item_id, ended_at DESC)
  WHERE ended_at IS NOT NULL;

DROP FUNCTION IF EXISTS public.get_operator_new_queue();

CREATE FUNCTION public.get_operator_new_queue()
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
        AND COALESCE(m.created_at, wi.created_at) <= last_cycle.ended_at THEN 'returned'
      ELSE 'new'
    END,
    p.display_name,
    ch.name,
    ch.avatar_url,
    COALESCE(m.content, c.last_message_preview, ''),
    wi.last_activity_at,
    wi.created_at
  FROM public.conversation_work_items wi
  JOIN public.conversations c ON c.id = wi.conversation_id
  JOIN public.characters ch ON ch.id = wi.character_id
  LEFT JOIN public.profiles p ON p.user_id = wi.client_id
  LEFT JOIN public.messages m ON m.id = wi.last_client_message_id
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

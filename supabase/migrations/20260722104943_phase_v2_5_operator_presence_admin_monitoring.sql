-- Phase V2-5: admin-only operational visibility for operator presence and NEW work.

CREATE OR REPLACE FUNCTION public.get_admin_operator_presence_overview()
RETURNS TABLE (
  operator_id UUID,
  presence_status TEXT,
  last_seen_at TIMESTAMPTZ,
  active_work_item_count INTEGER,
  eligible_new_queue_count INTEGER,
  stale_returned_count INTEGER,
  held_conversations JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _stale_minutes INTEGER := GREATEST(private.setting_int('operator_heartbeat_stale_minutes', 5), 1);
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  RETURN QUERY
  WITH active_items AS (
    SELECT
      wi.responsible_operator_id AS operator_id,
      COUNT(*)::INTEGER AS active_work_item_count,
      jsonb_agg(
        jsonb_build_object(
          'conversation_id', wi.conversation_id,
          'character_name', ch.name,
          'client_display_name', p.display_name,
          'status', wi.status,
          'last_activity_at', wi.last_activity_at
        )
        ORDER BY wi.last_activity_at DESC
      ) AS held_conversations
    FROM public.conversation_work_items wi
    JOIN public.conversations c ON c.id = wi.conversation_id
    JOIN public.characters ch ON ch.id = wi.character_id
    LEFT JOIN public.profiles p ON p.user_id = wi.client_id
    WHERE wi.status IN ('assigned', 'in_progress')
      AND wi.responsible_operator_id IS NOT NULL
      AND c.status <> 'closed'::public.conversation_status
    GROUP BY wi.responsible_operator_id
  ),
  eligible_new_items AS (
    SELECT
      coa.operator_id,
      COUNT(*)::INTEGER AS eligible_new_queue_count
    FROM public.character_operator_assignments coa
    JOIN public.conversation_work_items wi
      ON wi.character_id = coa.character_id
      AND wi.status = 'new'
    JOIN public.conversations c
      ON c.id = wi.conversation_id
      AND c.status <> 'closed'::public.conversation_status
    GROUP BY coa.operator_id
  ),
  stale_returns AS (
    SELECT
      cycle.operator_id,
      COUNT(*)::INTEGER AS stale_returned_count
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.end_reason = 'timeout'
      AND cycle.ended_at >= clock_timestamp() - INTERVAL '24 hours'
    GROUP BY cycle.operator_id
  )
  SELECT
    o.id,
    CASE
      WHEN o.last_seen_at IS NULL
        OR o.last_seen_at < clock_timestamp() - make_interval(mins => _stale_minutes)
        THEN 'offline'
      WHEN o.last_seen_at < clock_timestamp() - INTERVAL '90 seconds'
        THEN 'idle'
      ELSE 'online'
    END,
    o.last_seen_at,
    COALESCE(active_items.active_work_item_count, 0),
    COALESCE(eligible_new_items.eligible_new_queue_count, 0),
    COALESCE(stale_returns.stale_returned_count, 0),
    COALESCE(active_items.held_conversations, '[]'::JSONB)
  FROM public.operators o
  LEFT JOIN active_items ON active_items.operator_id = o.id
  LEFT JOIN eligible_new_items ON eligible_new_items.operator_id = o.id
  LEFT JOIN stale_returns ON stale_returns.operator_id = o.id
  WHERE o.deleted_at IS NULL
  ORDER BY o.full_name;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_new_queue_overview()
RETURNS TABLE (
  character_id UUID,
  character_name TEXT,
  new_queue_count INTEGER,
  waiting_long_count INTEGER,
  returned_to_queue_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _waiting_minutes INTEGER := GREATEST(private.setting_int('conversation_waiting_sla_minutes', 15), 1);
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  RETURN QUERY
  SELECT
    wi.character_id,
    ch.name,
    COUNT(*)::INTEGER,
    COUNT(*) FILTER (
      WHERE wi.last_activity_at < clock_timestamp() - make_interval(mins => _waiting_minutes)
    )::INTEGER,
    COUNT(*) FILTER (
      WHERE last_cycle.end_reason IN ('released', 'reassigned', 'timeout')
        AND COALESCE(last_client_message.created_at, wi.created_at) <= last_cycle.ended_at
    )::INTEGER
  FROM public.conversation_work_items wi
  JOIN public.conversations c ON c.id = wi.conversation_id
  JOIN public.characters ch ON ch.id = wi.character_id
  LEFT JOIN public.messages last_client_message ON last_client_message.id = wi.last_client_message_id
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
  GROUP BY wi.character_id, ch.name
  ORDER BY COUNT(*) DESC, ch.name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_operator_presence_overview()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_operator_presence_overview() TO authenticated;

REVOKE ALL ON FUNCTION public.get_admin_new_queue_overview()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_new_queue_overview() TO authenticated;

NOTIFY pgrst, 'reload schema';

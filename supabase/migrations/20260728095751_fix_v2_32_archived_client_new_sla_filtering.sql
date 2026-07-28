-- Restore the active-client eligibility contract that V2-31 accidentally
-- omitted while extending the NEW queue with SLA fields.

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
  created_at TIMESTAMPTZ,
  wait_seconds INTEGER,
  sla_state TEXT
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

  SELECT operator.id INTO _operator_id
  FROM public.operators operator
  WHERE operator.user_id = _user_id
    AND operator.is_active = TRUE
    AND operator.deleted_at IS NULL
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  RETURN QUERY
  SELECT
    work_item.id,
    work_item.conversation_id,
    work_item.character_id,
    work_item.status,
    CASE
      WHEN last_cycle.end_reason IN ('released', 'reassigned', 'timeout')
        AND client_message.created_at <= last_cycle.ended_at THEN 'returned'
      ELSE 'new'
    END,
    profile.display_name,
    character.name,
    character.avatar_url,
    COALESCE(client_message.content, conversation.last_message_preview, ''),
    work_item.last_activity_at,
    work_item.created_at,
    wait_metrics.wait_seconds,
    CASE
      WHEN wait_metrics.wait_seconds >= 900 THEN 'critical'
      WHEN wait_metrics.wait_seconds >= 300 THEN 'warning'
      ELSE 'normal'
    END
  FROM public.conversation_work_items work_item
  JOIN public.conversations conversation ON conversation.id = work_item.conversation_id
  JOIN public.characters character ON character.id = work_item.character_id
  JOIN public.messages client_message ON client_message.id = work_item.last_client_message_id
  JOIN public.profiles profile ON profile.user_id = work_item.client_id
  CROSS JOIN LATERAL (
    SELECT GREATEST(
      0,
      FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - client_message.created_at)))::INTEGER
    ) AS wait_seconds
  ) wait_metrics
  LEFT JOIN LATERAL (
    SELECT cycle.end_reason, cycle.ended_at
    FROM public.conversation_handling_cycles cycle
    WHERE cycle.work_item_id = work_item.id
      AND cycle.ended_at IS NOT NULL
    ORDER BY cycle.ended_at DESC
    LIMIT 1
  ) last_cycle ON TRUE
  WHERE work_item.status = 'new'
    AND conversation.status <> 'closed'::public.conversation_status
    AND profile.status = 'active'
    AND profile.deleted_at IS NULL
    AND profile.pii_archived_at IS NULL
    AND client_message.sender_type = 'client'::public.sender_type
    AND NOT EXISTS (
      SELECT 1
      FROM public.conversation_handling_cycles cycle
      WHERE cycle.work_item_id = work_item.id
        AND cycle.ended_at IS NULL
    )
    AND EXISTS (
      SELECT 1
      FROM public.character_operator_assignments assignment
      WHERE assignment.character_id = work_item.character_id
        AND assignment.operator_id = _operator_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.operator_client_blocks block
      WHERE block.operator_id = _operator_id
        AND block.client_id = work_item.client_id
    )
  ORDER BY work_item.last_activity_at DESC, work_item.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_operator_new_sla_summary()
RETURNS TABLE (
  total_new INTEGER,
  warning_count INTEGER,
  critical_count INTEGER,
  oldest_wait_seconds INTEGER
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

  SELECT operator.id INTO _operator_id
  FROM public.operators operator
  WHERE operator.user_id = _user_id
    AND operator.is_active = TRUE
    AND operator.deleted_at IS NULL
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_record_required';
  END IF;

  RETURN QUERY
  WITH visible_items AS (
    SELECT GREATEST(
      0,
      FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - client_message.created_at)))::INTEGER
    ) AS wait_seconds
    FROM public.conversation_work_items work_item
    JOIN public.conversations conversation ON conversation.id = work_item.conversation_id
    JOIN public.messages client_message ON client_message.id = work_item.last_client_message_id
    JOIN public.profiles profile ON profile.user_id = work_item.client_id
    WHERE work_item.status = 'new'
      AND conversation.status <> 'closed'::public.conversation_status
      AND profile.status = 'active'
      AND profile.deleted_at IS NULL
      AND profile.pii_archived_at IS NULL
      AND client_message.sender_type = 'client'::public.sender_type
      AND NOT EXISTS (
        SELECT 1
        FROM public.conversation_handling_cycles cycle
        WHERE cycle.work_item_id = work_item.id
          AND cycle.ended_at IS NULL
      )
      AND EXISTS (
        SELECT 1
        FROM public.character_operator_assignments assignment
        WHERE assignment.character_id = work_item.character_id
          AND assignment.operator_id = _operator_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.operator_client_blocks block
        WHERE block.operator_id = _operator_id
          AND block.client_id = work_item.client_id
      )
  )
  SELECT
    COUNT(*)::INTEGER,
    COUNT(*) FILTER (WHERE wait_seconds >= 300)::INTEGER,
    COUNT(*) FILTER (WHERE wait_seconds >= 900)::INTEGER,
    COALESCE(MAX(wait_seconds), 0)::INTEGER
  FROM visible_items;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_new_sla_summary()
RETURNS TABLE (
  character_id UUID,
  character_name TEXT,
  total_new INTEGER,
  warning_count INTEGER,
  critical_count INTEGER,
  oldest_wait_seconds INTEGER,
  eligible_operator_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  RETURN QUERY
  WITH new_items AS (
    SELECT
      work_item.character_id,
      GREATEST(
        0,
        FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - client_message.created_at)))::INTEGER
      ) AS wait_seconds
    FROM public.conversation_work_items work_item
    JOIN public.conversations conversation ON conversation.id = work_item.conversation_id
    JOIN public.messages client_message ON client_message.id = work_item.last_client_message_id
    JOIN public.profiles profile ON profile.user_id = work_item.client_id
    WHERE work_item.status = 'new'
      AND conversation.status <> 'closed'::public.conversation_status
      AND profile.status = 'active'
      AND profile.deleted_at IS NULL
      AND profile.pii_archived_at IS NULL
      AND client_message.sender_type = 'client'::public.sender_type
      AND NOT EXISTS (
        SELECT 1
        FROM public.conversation_handling_cycles cycle
        WHERE cycle.work_item_id = work_item.id
          AND cycle.ended_at IS NULL
      )
  )
  SELECT
    item.character_id,
    character.name,
    COUNT(*)::INTEGER,
    COUNT(*) FILTER (WHERE item.wait_seconds >= 300)::INTEGER,
    COUNT(*) FILTER (WHERE item.wait_seconds >= 900)::INTEGER,
    COALESCE(MAX(item.wait_seconds), 0)::INTEGER,
    (
      SELECT COUNT(*)::INTEGER
      FROM public.character_operator_assignments assignment
      JOIN public.operators operator ON operator.id = assignment.operator_id
      WHERE assignment.character_id = item.character_id
        AND operator.is_active = TRUE
        AND operator.deleted_at IS NULL
    )
  FROM new_items item
  JOIN public.characters character ON character.id = item.character_id
  GROUP BY item.character_id, character.name
  ORDER BY MAX(item.wait_seconds) DESC, character.name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_operator_new_queue() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_operator_new_sla_summary() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admin_new_sla_summary() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_operator_new_queue() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_operator_new_sla_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_new_sla_summary() TO authenticated;

NOTIFY pgrst, 'reload schema';

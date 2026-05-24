-- Fix Phase 2C unread RPC performance for shared inbox operators.
-- Avoid per-row SECURITY DEFINER authorization checks over large conversation lists.

CREATE INDEX IF NOT EXISTS idx_conversations_character_last_message
  ON public.conversations(character_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_sender
  ON public.messages(conversation_id, created_at DESC, sender_type);

CREATE OR REPLACE FUNCTION public.get_my_conversation_unread_counts(_conversation_ids UUID[])
RETURNS TABLE (
  conversation_id UUID,
  unread_count INTEGER,
  last_read_at TIMESTAMPTZ
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH requested AS (
    SELECT DISTINCT unnest(COALESCE(_conversation_ids, ARRAY[]::UUID[])) AS conversation_id
  ),
  my_role AS (
    SELECT public.get_my_role() AS role
  ),
  my_operator AS (
    SELECT id
    FROM public.operators
    WHERE user_id = auth.uid()
      AND is_active = true
    LIMIT 1
  ),
  readable AS (
    SELECT
      c.id AS conversation_id,
      CASE
        WHEN c.client_id = auth.uid() THEN 'client'
        WHEN (SELECT role FROM my_role) = 'admin'::public.app_role THEN 'operator'
        WHEN mo.id IS NOT NULL THEN 'operator'
        ELSE NULL
      END AS viewer_side,
      crs.last_read_at
    FROM requested r
    JOIN public.conversations c
      ON c.id = r.conversation_id
    LEFT JOIN my_operator mo
      ON true
    LEFT JOIN public.character_operator_assignments coa
      ON coa.character_id = c.character_id
     AND coa.operator_id = mo.id
    LEFT JOIN public.conversation_read_states crs
      ON crs.conversation_id = c.id
     AND crs.user_id = auth.uid()
    WHERE
      c.client_id = auth.uid()
      OR (SELECT role FROM my_role) = 'admin'::public.app_role
      OR coa.operator_id IS NOT NULL
  )
  SELECT
    r.conversation_id,
    COUNT(m.id)::INTEGER AS unread_count,
    r.last_read_at
  FROM readable r
  LEFT JOIN public.messages m
    ON m.conversation_id = r.conversation_id
   AND m.created_at > COALESCE(r.last_read_at, '-infinity'::TIMESTAMPTZ)
   AND (
     (r.viewer_side = 'client' AND m.sender_type <> 'client'::public.sender_type)
     OR
     (r.viewer_side = 'operator' AND m.sender_type = 'client'::public.sender_type)
   )
  WHERE r.viewer_side IS NOT NULL
  GROUP BY r.conversation_id, r.last_read_at;
$$;

REVOKE EXECUTE ON FUNCTION public.get_my_conversation_unread_counts(UUID[]) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.get_my_conversation_unread_counts(UUID[]) TO authenticated;

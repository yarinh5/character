-- V2-17: expose the handling-cycle responsibility state to assigned operators.
-- The active handling cycle remains the sole source of responsibility; locks
-- only govern concurrent composition and never change NEW visibility.

CREATE OR REPLACE FUNCTION public.get_operator_conversation_responsibility(
  _conversation_id UUID
)
RETURNS TABLE(state TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _operator_id UUID;
  _conversation public.conversations%ROWTYPE;
  _responsible_operator_id UUID;
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

  SELECT *
  INTO _conversation
  FROM public.conversations
  WHERE id = _conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation_not_found';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.character_operator_assignments coa
    WHERE coa.character_id = _conversation.character_id
      AND coa.operator_id = _operator_id
  ) THEN
    RAISE EXCEPTION 'operator_not_assigned_to_character';
  END IF;

  IF _conversation.status = 'closed'::public.conversation_status THEN
    RETURN QUERY SELECT 'closed'::TEXT;
    RETURN;
  END IF;

  SELECT cycle.operator_id
  INTO _responsible_operator_id
  FROM public.conversation_handling_cycles cycle
  WHERE cycle.conversation_id = _conversation.id
    AND cycle.ended_at IS NULL
  ORDER BY cycle.started_at DESC
  LIMIT 1;

  RETURN QUERY
  SELECT CASE
    WHEN _responsible_operator_id IS NULL THEN 'available'
    WHEN _responsible_operator_id = _operator_id THEN 'mine'
    ELSE 'other'
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.get_operator_conversation_responsibility(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operator_conversation_responsibility(UUID)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

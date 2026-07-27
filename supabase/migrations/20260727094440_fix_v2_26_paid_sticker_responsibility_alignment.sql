-- V2-26: Paid Stickers follow the current handling responsibility, not legacy assignment or locks.
CREATE OR REPLACE FUNCTION private.resolve_paid_sticker_payout_operator(
  _conversation_id UUID
)
RETURNS TABLE (
  operator_id UUID,
  user_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  SELECT cycle.operator_id, operator.user_id
  INTO operator_id, user_id
  FROM public.conversation_handling_cycles cycle
  JOIN public.operators operator ON operator.id = cycle.operator_id
  WHERE cycle.conversation_id = _conversation_id
    AND cycle.ended_at IS NULL
    AND operator.is_active = TRUE
    AND operator.deleted_at IS NULL
  ORDER BY cycle.started_at DESC, cycle.id DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT message.operator_id, operator.user_id
  INTO operator_id, user_id
  FROM public.messages message
  JOIN public.operators operator ON operator.id = message.operator_id
  WHERE message.conversation_id = _conversation_id
    AND message.sender_type = 'operator'::public.sender_type
    AND message.operator_id IS NOT NULL
    AND operator.is_active = TRUE
    AND operator.deleted_at IS NULL
  ORDER BY message.created_at DESC, message.id DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN NEXT;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.resolve_paid_sticker_payout_operator(UUID) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

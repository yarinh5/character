-- V2-12: an operator response completes the active handling cycle. NEW remains
-- a queue of free client work: after the answer, a later client message creates
-- a fresh work item instead of being hidden behind the old cycle.

CREATE OR REPLACE FUNCTION private.close_handling_cycle_on_staff_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF NEW.sender_type NOT IN ('operator'::public.sender_type, 'admin'::public.sender_type) THEN
    RETURN NEW;
  END IF;

  IF NEW.operator_id IS NULL THEN
    RETURN NEW;
  END IF;

  WITH answered_items AS (
    UPDATE public.conversation_handling_cycles cycle
    SET ended_at = NEW.created_at,
        end_reason = 'answered'
    FROM public.conversation_work_items wi
    WHERE wi.id = cycle.work_item_id
      AND wi.conversation_id = NEW.conversation_id
      AND wi.status IN ('assigned', 'in_progress')
      AND cycle.ended_at IS NULL
      AND cycle.operator_id = NEW.operator_id
      AND cycle.started_at <= NEW.created_at
    RETURNING wi.id
  )
  UPDATE public.conversation_work_items wi
  SET status = 'closed'
  WHERE wi.id IN (SELECT id FROM answered_items);

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.close_handling_cycle_on_staff_message()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.close_handling_cycle_on_staff_message()
  TO service_role;

DROP TRIGGER IF EXISTS close_handling_cycle_on_staff_message
  ON public.messages;

CREATE TRIGGER close_handling_cycle_on_staff_message
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION private.close_handling_cycle_on_staff_message();

-- Backfill active cycles that already received an operator response. Use the
-- first matching staff response so the cycle closes at the actual answer time.
WITH answered_cycles AS (
  SELECT
    cycle.id AS cycle_id,
    wi.id AS work_item_id,
    first_answer.created_at AS answered_at
  FROM public.conversation_handling_cycles cycle
  JOIN public.conversation_work_items wi ON wi.id = cycle.work_item_id
  JOIN LATERAL (
    SELECT m.created_at
    FROM public.messages m
    WHERE m.conversation_id = cycle.conversation_id
      AND m.sender_type IN ('operator'::public.sender_type, 'admin'::public.sender_type)
      AND m.operator_id = cycle.operator_id
      AND m.created_at >= cycle.started_at
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT 1
  ) first_answer ON true
  WHERE cycle.ended_at IS NULL
    AND wi.status IN ('assigned', 'in_progress')
),
closed_cycles AS (
  UPDATE public.conversation_handling_cycles cycle
  SET ended_at = answered_cycles.answered_at,
      end_reason = 'answered'
  FROM answered_cycles
  WHERE cycle.id = answered_cycles.cycle_id
  RETURNING answered_cycles.work_item_id
)
UPDATE public.conversation_work_items wi
SET status = 'closed'
WHERE wi.id IN (SELECT work_item_id FROM closed_cycles);

-- If the latest message after that answer is already from the client, recreate
-- a free NEW work item for that pending client message.
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
  AND latest_message.sender_type = 'client'::public.sender_type
  AND NOT EXISTS (
    SELECT 1
    FROM public.conversation_work_items wi
    WHERE wi.conversation_id = c.id
      AND wi.status IN ('new', 'assigned', 'in_progress')
  );

NOTIFY pgrst, 'reload schema';

-- Phase V2-6 follow-up: repair pre-existing NEW items for already assigned conversations.

UPDATE public.conversation_work_items wi
SET status = 'in_progress',
    responsible_operator_id = c.assigned_operator_id,
    assigned_at = COALESCE(wi.assigned_at, c.updated_at, c.created_at)
FROM public.conversations c
WHERE c.id = wi.conversation_id
  AND c.status <> 'closed'::public.conversation_status
  AND c.assigned_operator_id IS NOT NULL
  AND wi.status = 'new';

NOTIFY pgrst, 'reload schema';

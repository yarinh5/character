-- Phase V2-1: operator-facing NEW queue. Direct table access stays closed;
-- workers read and claim items only through the guarded RPCs below.

CREATE TABLE public.conversation_work_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL,
  character_id UUID NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'assigned', 'in_progress', 'closed')),
  responsible_operator_id UUID REFERENCES public.operators(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ,
  last_client_message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT conversation_work_items_assignment_state_check CHECK (
    (status = 'new' AND responsible_operator_id IS NULL AND assigned_at IS NULL)
    OR (status IN ('assigned', 'in_progress') AND responsible_operator_id IS NOT NULL AND assigned_at IS NOT NULL)
    OR status = 'closed'
  )
);

CREATE UNIQUE INDEX conversation_work_items_one_active_per_conversation_idx
  ON public.conversation_work_items (conversation_id)
  WHERE status IN ('new', 'assigned', 'in_progress');

CREATE INDEX conversation_work_items_status_last_activity_idx
  ON public.conversation_work_items (status, last_activity_at DESC);

CREATE INDEX conversation_work_items_character_id_idx
  ON public.conversation_work_items (character_id);

CREATE INDEX conversation_work_items_responsible_operator_id_idx
  ON public.conversation_work_items (responsible_operator_id);

CREATE INDEX conversation_work_items_last_activity_idx
  ON public.conversation_work_items (last_activity_at DESC);

ALTER TABLE public.conversation_work_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.conversation_work_items FROM PUBLIC, anon, authenticated;

CREATE TRIGGER set_conversation_work_items_updated_at
  BEFORE UPDATE ON public.conversation_work_items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

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
    last_client_message_id,
    last_activity_at
  )
  VALUES (
    _conversation.id,
    _conversation.client_id,
    _conversation.character_id,
    'new',
    NEW.id,
    NEW.created_at
  )
  ON CONFLICT (conversation_id)
  WHERE status IN ('new', 'assigned', 'in_progress')
  DO UPDATE SET
    last_client_message_id = EXCLUDED.last_client_message_id,
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

DROP TRIGGER IF EXISTS upsert_conversation_work_item_from_client_message
  ON public.messages;

CREATE TRIGGER upsert_conversation_work_item_from_client_message
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION private.upsert_conversation_work_item_from_client_message();

CREATE OR REPLACE FUNCTION private.close_conversation_work_items()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF NEW.status = 'closed'::public.conversation_status
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE public.conversation_work_items
    SET status = 'closed'
    WHERE conversation_id = NEW.id
      AND status IN ('new', 'assigned', 'in_progress');
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.close_conversation_work_items()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.close_conversation_work_items() TO service_role;

DROP TRIGGER IF EXISTS close_conversation_work_items ON public.conversations;

CREATE TRIGGER close_conversation_work_items
  AFTER UPDATE OF status ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION private.close_conversation_work_items();

-- Backfill only unassigned, client-last conversations so the new queue can start
-- with genuinely unhandled work without reassigning ongoing conversations.
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
  AND NOT EXISTS (
    SELECT 1
    FROM public.conversation_work_items wi
    WHERE wi.conversation_id = c.id
      AND wi.status IN ('new', 'assigned', 'in_progress')
  );

CREATE OR REPLACE FUNCTION public.get_operator_new_queue()
RETURNS TABLE (
  work_item_id UUID,
  conversation_id UUID,
  status TEXT,
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
    wi.status,
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

CREATE OR REPLACE FUNCTION public.claim_new_conversation(_work_item_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _guard RECORD;
  _work_item public.conversation_work_items%ROWTYPE;
  _conversation_id UUID;
BEGIN
  SELECT conversation_id
  INTO _conversation_id
  FROM public.conversation_work_items
  WHERE id = _work_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_item_not_found';
  END IF;

  -- This existing guard enforces active status, character assignment, closed
  -- conversation checks, and the configured open/warning/lock behavior.
  SELECT *
  INTO _guard
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);

  SELECT *
  INTO _work_item
  FROM public.conversation_work_items
  WHERE id = _work_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'work_item_not_found';
  END IF;

  IF _work_item.status <> 'new' THEN
    IF _work_item.responsible_operator_id = _guard.operator_id THEN
      RETURN jsonb_build_object(
        'claimed', true,
        'already_claimed', true,
        'work_item_id', _work_item.id,
        'conversation_id', _work_item.conversation_id,
        'status', _work_item.status
      );
    END IF;

    RAISE EXCEPTION 'conversation_already_claimed';
  END IF;

  UPDATE public.conversations
  SET assigned_operator_id = _guard.operator_id,
      updated_at = clock_timestamp()
  WHERE id = _work_item.conversation_id;

  UPDATE public.conversation_work_items
  SET status = 'assigned',
      responsible_operator_id = _guard.operator_id,
      assigned_at = clock_timestamp()
  WHERE id = _work_item.id
  RETURNING * INTO _work_item;

  RETURN jsonb_build_object(
    'claimed', true,
    'already_claimed', false,
    'work_item_id', _work_item.id,
    'conversation_id', _work_item.conversation_id,
    'status', _work_item.status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_operator_new_queue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operator_new_queue() TO authenticated;

REVOKE ALL ON FUNCTION public.claim_new_conversation(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_new_conversation(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

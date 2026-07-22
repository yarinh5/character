-- Phase V2-2: explicit operator handling cycles and heartbeat-based return to NEW.

ALTER TABLE public.operators
  ADD COLUMN last_seen_at TIMESTAMPTZ,
  ADD COLUMN presence_status TEXT NOT NULL DEFAULT 'offline'
    CHECK (presence_status IN ('online', 'idle', 'offline'));

CREATE INDEX operators_presence_status_last_seen_idx
  ON public.operators (presence_status, last_seen_at DESC);

CREATE TABLE public.conversation_handling_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  work_item_id UUID REFERENCES public.conversation_work_items(id) ON DELETE SET NULL,
  operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE RESTRICT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ended_at TIMESTAMPTZ,
  end_reason TEXT CHECK (end_reason IN ('answered', 'released', 'timeout', 'reassigned', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT conversation_handling_cycles_end_state_check CHECK (
    (ended_at IS NULL AND end_reason IS NULL)
    OR (ended_at IS NOT NULL AND end_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX conversation_handling_cycles_one_active_work_item_idx
  ON public.conversation_handling_cycles (work_item_id)
  WHERE ended_at IS NULL;

CREATE INDEX conversation_handling_cycles_conversation_started_idx
  ON public.conversation_handling_cycles (conversation_id, started_at DESC);

CREATE INDEX conversation_handling_cycles_operator_started_idx
  ON public.conversation_handling_cycles (operator_id, started_at DESC);

ALTER TABLE public.conversation_handling_cycles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.conversation_handling_cycles FROM PUBLIC, anon, authenticated;

-- Preserve an active V2-1 responsibility as the first recorded handling cycle.
INSERT INTO public.conversation_handling_cycles (
  conversation_id,
  work_item_id,
  operator_id,
  started_at
)
SELECT
  wi.conversation_id,
  wi.id,
  wi.responsible_operator_id,
  COALESCE(wi.assigned_at, wi.created_at)
FROM public.conversation_work_items wi
WHERE wi.status IN ('assigned', 'in_progress')
  AND wi.responsible_operator_id IS NOT NULL
ON CONFLICT (work_item_id) WHERE ended_at IS NULL DO NOTHING;

CREATE OR REPLACE FUNCTION private.return_stale_work_items_to_new()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _stale_minutes INTEGER := GREATEST(private.setting_int('operator_heartbeat_stale_minutes', 5), 1);
  _item RECORD;
  _returned_count INTEGER := 0;
BEGIN
  FOR _item IN
    SELECT
      wi.id AS work_item_id,
      wi.conversation_id,
      wi.responsible_operator_id
    FROM public.conversation_work_items wi
    JOIN public.conversations c ON c.id = wi.conversation_id
    JOIN public.operators o ON o.id = wi.responsible_operator_id
    WHERE wi.status IN ('assigned', 'in_progress')
      AND c.status <> 'closed'::public.conversation_status
      AND (
        o.last_seen_at IS NULL
        OR o.last_seen_at < clock_timestamp() - make_interval(mins => _stale_minutes)
      )
    ORDER BY wi.last_activity_at ASC
    FOR UPDATE OF wi SKIP LOCKED
  LOOP
    UPDATE public.conversation_handling_cycles
    SET ended_at = clock_timestamp(),
        end_reason = 'timeout'
    WHERE work_item_id = _item.work_item_id
      AND ended_at IS NULL;

    UPDATE public.conversation_locks
    SET released_at = clock_timestamp(),
        released_by_user_id = NULL,
        release_reason = 'heartbeat_timeout'
    WHERE conversation_id = _item.conversation_id
      AND locked_by_operator_id = _item.responsible_operator_id
      AND released_at IS NULL;

    UPDATE public.conversations
    SET assigned_operator_id = NULL,
        updated_at = clock_timestamp()
    WHERE id = _item.conversation_id
      AND assigned_operator_id = _item.responsible_operator_id;

    UPDATE public.conversation_work_items
    SET status = 'new',
        responsible_operator_id = NULL,
        assigned_at = NULL,
        last_activity_at = clock_timestamp()
    WHERE id = _item.work_item_id;

    UPDATE public.operators
    SET presence_status = 'offline'
    WHERE id = _item.responsible_operator_id
      AND (last_seen_at IS NULL OR last_seen_at < clock_timestamp() - make_interval(mins => _stale_minutes));

    _returned_count := _returned_count + 1;
  END LOOP;

  RETURN _returned_count;
END;
$$;

REVOKE ALL ON FUNCTION private.return_stale_work_items_to_new()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.return_stale_work_items_to_new() TO service_role;

CREATE OR REPLACE FUNCTION public.operator_heartbeat()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _operator_id UUID;
  _returned_count INTEGER;
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

  _returned_count := private.return_stale_work_items_to_new();

  UPDATE public.operators
  SET last_seen_at = clock_timestamp(),
      presence_status = 'online'
  WHERE id = _operator_id;

  RETURN jsonb_build_object(
    'operator_id', _operator_id,
    'presence_status', 'online',
    'returned_stale_work_items', _returned_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.return_stale_work_items_to_new()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.is_admin() IS NOT TRUE THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  RETURN private.return_stale_work_items_to_new();
END;
$$;

CREATE OR REPLACE FUNCTION public.release_operator_conversation(
  _conversation_id UUID,
  _reason TEXT DEFAULT 'released'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _guard RECORD;
  _work_item public.conversation_work_items%ROWTYPE;
  _conversation public.conversations%ROWTYPE;
  _release_reason TEXT := COALESCE(NULLIF(btrim(_reason), ''), 'released');
BEGIN
  IF _release_reason NOT IN ('released', 'reassigned') THEN
    RAISE EXCEPTION 'invalid_release_reason';
  END IF;

  -- Keep release aligned with the same active/assignment/lock guard used by sends.
  SELECT *
  INTO _guard
  FROM private.assert_operator_can_send_conversation_message(_conversation_id);

  SELECT *
  INTO _work_item
  FROM public.conversation_work_items
  WHERE conversation_id = _conversation_id
    AND status IN ('assigned', 'in_progress')
  FOR UPDATE;

  IF NOT FOUND OR _work_item.responsible_operator_id <> _guard.operator_id THEN
    RAISE EXCEPTION 'conversation_not_responsible_operator';
  END IF;

  SELECT *
  INTO _conversation
  FROM public.conversations
  WHERE id = _conversation_id
  FOR UPDATE;

  IF _conversation.status = 'closed'::public.conversation_status THEN
    UPDATE public.conversation_handling_cycles
    SET ended_at = clock_timestamp(),
        end_reason = 'closed'
    WHERE work_item_id = _work_item.id
      AND ended_at IS NULL;

    UPDATE public.conversation_work_items
    SET status = 'closed'
    WHERE id = _work_item.id;

    RETURN jsonb_build_object('released', false, 'status', 'closed');
  END IF;

  UPDATE public.conversation_handling_cycles
  SET ended_at = clock_timestamp(),
      end_reason = _release_reason
  WHERE work_item_id = _work_item.id
    AND ended_at IS NULL;

  UPDATE public.conversations
  SET assigned_operator_id = NULL,
      updated_at = clock_timestamp()
  WHERE id = _conversation_id
    AND assigned_operator_id = _guard.operator_id;

  UPDATE public.conversation_work_items
  SET status = 'new',
      responsible_operator_id = NULL,
      assigned_at = NULL,
      last_activity_at = clock_timestamp()
  WHERE id = _work_item.id
  RETURNING * INTO _work_item;

  IF EXISTS (
    SELECT 1
    FROM public.conversation_locks l
    WHERE l.conversation_id = _conversation_id
      AND l.locked_by_operator_id = _guard.operator_id
      AND l.released_at IS NULL
  ) THEN
    PERFORM public.release_conversation_lock(_conversation_id);
  END IF;

  RETURN jsonb_build_object(
    'released', true,
    'work_item_id', _work_item.id,
    'conversation_id', _work_item.conversation_id,
    'status', _work_item.status
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.close_conversation_work_items()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF NEW.status = 'closed'::public.conversation_status
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    WITH closed_items AS (
      UPDATE public.conversation_work_items
      SET status = 'closed'
      WHERE conversation_id = NEW.id
        AND status IN ('new', 'assigned', 'in_progress')
      RETURNING id
    )
    UPDATE public.conversation_handling_cycles cycle
    SET ended_at = clock_timestamp(),
        end_reason = 'closed'
    FROM closed_items item
    WHERE cycle.work_item_id = item.id
      AND cycle.ended_at IS NULL;
  END IF;

  RETURN NEW;
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

  INSERT INTO public.conversation_handling_cycles (
    conversation_id,
    work_item_id,
    operator_id,
    started_at
  )
  VALUES (
    _work_item.conversation_id,
    _work_item.id,
    _guard.operator_id,
    clock_timestamp()
  );

  RETURN jsonb_build_object(
    'claimed', true,
    'already_claimed', false,
    'work_item_id', _work_item.id,
    'conversation_id', _work_item.conversation_id,
    'status', _work_item.status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.operator_heartbeat() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.operator_heartbeat() TO authenticated;

REVOKE ALL ON FUNCTION public.return_stale_work_items_to_new() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.return_stale_work_items_to_new() TO authenticated;

REVOKE ALL ON FUNCTION public.release_operator_conversation(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_operator_conversation(UUID, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION private.close_conversation_work_items() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.close_conversation_work_items() TO service_role;

REVOKE ALL ON FUNCTION public.claim_new_conversation(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_new_conversation(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

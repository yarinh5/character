CREATE OR REPLACE FUNCTION public.request_conversation_deletion(
  _conversation_id UUID, _reason TEXT, _idempotency_key UUID, _confirmed BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (id UUID, status TEXT, requested_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _actor UUID := auth.uid(); _request public.conversation_deletion_requests%ROWTYPE; _now TIMESTAMPTZ := clock_timestamp();
BEGIN
  PERFORM private.acquire_handling_writer_barrier();
  IF _actor IS NULL OR NOT public.is_admin() THEN RAISE EXCEPTION 'admin_only' USING ERRCODE = '42501'; END IF;
  IF _confirmed IS NOT TRUE THEN RAISE EXCEPTION 'explicit_confirmation_required'; END IF;
  IF _conversation_id IS NULL OR _idempotency_key IS NULL THEN RAISE EXCEPTION 'invalid_deletion_request'; END IF;
  IF char_length(btrim(COALESCE(_reason, ''))) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'deletion_reason_required'; END IF;
  PERFORM 1 FROM public.conversations WHERE conversations.id = _conversation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  INSERT INTO public.conversation_deletion_requests (
    conversation_id, requested_by, idempotency_key, reason, status,
    access_blocked_at, deletion_due_at, retention_policy_version, updated_at
  ) VALUES (
    _conversation_id, _actor, _idempotency_key, btrim(_reason), 'access_blocked',
    _now, _now + interval '7 days', 'p04-2026-11-11', _now
  ) ON CONFLICT (requested_by, idempotency_key) DO NOTHING RETURNING * INTO _request;
  IF _request.id IS NULL THEN
    SELECT * INTO _request FROM public.conversation_deletion_requests request
    WHERE request.requested_by = _actor AND request.idempotency_key = _idempotency_key;
    IF _request.conversation_id IS DISTINCT FROM _conversation_id OR _request.reason IS DISTINCT FROM btrim(_reason) THEN
      RAISE EXCEPTION 'idempotency_key_reused';
    END IF;
  ELSE
    INSERT INTO private.conversation_deletion_steps(request_id, step_name, status)
    VALUES (_request.id, 'database_content', 'pending'), (_request.id, 'storage', 'pending'),
      (_request.id, 'finalize', 'pending');
    UPDATE public.conversations SET status = 'closed'::public.conversation_status,
      assigned_operator_id = NULL, updated_at = _now WHERE conversations.id = _conversation_id;
    UPDATE public.conversation_handling_cycles SET ended_at = _now, end_reason = 'closed'
    WHERE conversation_id = _conversation_id AND ended_at IS NULL;
    UPDATE public.conversation_work_items AS work_item
    SET status = 'closed', responsible_operator_id = NULL,
      assigned_at = NULL, updated_at = _now WHERE work_item.conversation_id = _conversation_id
      AND work_item.status IN ('new', 'assigned', 'in_progress');
    INSERT INTO public.audit_logs(actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (_actor, 'conversation_deletion_requested', 'conversation', _conversation_id,
      jsonb_build_object('request_id', _request.id, 'reason', btrim(_reason), 'access_blocked_at', _now));
  END IF;
  id := _request.id; status := _request.status; requested_at := _request.requested_at; RETURN NEXT;
END;
$$;

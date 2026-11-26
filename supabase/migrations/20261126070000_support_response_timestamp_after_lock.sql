CREATE OR REPLACE FUNCTION public.admin_add_support_ticket_message(
  _ticket_id UUID,
  _body TEXT,
  _visibility TEXT,
  _idempotency_key UUID
)
RETURNS TABLE (id UUID, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE
  _actor UUID := auth.uid();
  _ticket public.support_tickets%ROWTYPE;
  _message public.support_ticket_messages%ROWTYPE;
  _response_at TIMESTAMPTZ;
BEGIN
  IF _actor IS NULL OR public.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF _visibility NOT IN ('client', 'internal') THEN RAISE EXCEPTION 'invalid_visibility'; END IF;
  IF _idempotency_key IS NULL THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;
  IF char_length(btrim(COALESCE(_body, ''))) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'invalid_message'; END IF;
  SELECT * INTO _ticket FROM public.support_tickets WHERE support_tickets.id = _ticket_id FOR UPDATE;
  IF _ticket.id IS NULL THEN RAISE EXCEPTION 'support_ticket_not_found'; END IF;
  _response_at := clock_timestamp();

  INSERT INTO public.support_ticket_messages
    (ticket_id, author_user_id, author_kind, visibility, body, idempotency_key, created_at)
  VALUES (_ticket_id, _actor, 'admin', _visibility, btrim(_body), _idempotency_key, _response_at)
  ON CONFLICT (ticket_id, author_user_id, idempotency_key) DO NOTHING
  RETURNING * INTO _message;

  IF _message.id IS NULL THEN
    SELECT * INTO STRICT _message FROM public.support_ticket_messages
    WHERE ticket_id = _ticket_id AND author_user_id = _actor AND idempotency_key = _idempotency_key;
  ELSE
    UPDATE public.support_tickets
    SET status = CASE WHEN _visibility = 'client' THEN 'waiting_for_client' ELSE status END,
        first_human_response_at = CASE WHEN _visibility = 'client'
          THEN COALESCE(first_human_response_at, _response_at) ELSE first_human_response_at END,
        first_response_within_target = CASE
          WHEN _visibility = 'client' AND first_human_response_at IS NULL
            AND first_response_target_at IS NOT NULL
          THEN _response_at <= first_response_target_at
          ELSE first_response_within_target END,
        version = version + 1,
        updated_at = _response_at
    WHERE support_tickets.id = _ticket_id;
    INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
    VALUES (_actor,
      CASE WHEN _visibility = 'client' THEN 'support.ticket.replied' ELSE 'support.ticket.internal_note_added' END,
      'support_ticket', _ticket_id::text, jsonb_build_object('message_id', _message.id));
    IF _visibility = 'client' THEN
      PERFORM public.create_notification(
        _ticket.client_id, 'support_ticket_reply', 'תגובה חדשה בפניית התמיכה',
        NULL, '/app/support', NULL, jsonb_build_object('ticket_id', _ticket.id), 0
      );
    END IF;
  END IF;
  RETURN QUERY SELECT _message.id, _message.created_at;
END;
$$;

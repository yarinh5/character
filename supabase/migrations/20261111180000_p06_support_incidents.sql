-- P06 customer support and critical incident escalation.
-- External delivery remains configuration-gated; in-app notifications are authoritative.

CREATE TABLE public.support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  subject TEXT NOT NULL CHECK (char_length(btrim(subject)) BETWEEN 4 AND 120),
  category TEXT NOT NULL CHECK (category IN ('account', 'conversation', 'billing', 'privacy', 'technical', 'other')),
  description TEXT NOT NULL CHECK (char_length(btrim(description)) BETWEEN 10 AND 4000),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'waiting_for_client', 'closed')),
  assignee_admin_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  idempotency_key UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  closed_at TIMESTAMPTZ,
  UNIQUE (client_id, idempotency_key)
);

CREATE INDEX support_tickets_admin_queue_idx
  ON public.support_tickets (status, updated_at DESC, assignee_admin_id);
CREATE INDEX support_tickets_client_idx
  ON public.support_tickets (client_id, created_at DESC);

CREATE TABLE public.support_ticket_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  author_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('client', 'admin')),
  visibility TEXT NOT NULL CHECK (visibility IN ('client', 'internal')),
  body TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  idempotency_key UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (ticket_id, author_user_id, idempotency_key)
);

CREATE INDEX support_ticket_messages_ticket_idx
  ON public.support_ticket_messages (ticket_id, created_at);

CREATE TABLE private.support_operations_config (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  public_support_contact TEXT,
  business_owner_admin_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  deputy_admin_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  technical_contact TEXT,
  escalation_channel TEXT,
  support_hours TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (public_support_contact IS NULL OR char_length(public_support_contact) <= 300),
  CHECK (technical_contact IS NULL OR char_length(technical_contact) <= 300),
  CHECK (escalation_channel IS NULL OR char_length(escalation_channel) <= 300),
  CHECK (support_hours IS NULL OR char_length(support_hours) <= 300)
);

INSERT INTO private.support_operations_config (singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE public.support_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_type TEXT NOT NULL CHECK (incident_type IN ('outage', 'suspected_data_leak', 'incorrect_charge', 'significant_authorization_failure')),
  severity TEXT NOT NULL CHECK (severity IN ('medium', 'high', 'critical')),
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 4 AND 160),
  details TEXT NOT NULL CHECK (char_length(btrim(details)) BETWEEN 10 AND 4000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  owner_admin_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  opened_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  escalation_status TEXT NOT NULL CHECK (escalation_status IN ('pending_configuration', 'pending_delivery', 'delivered', 'failed')),
  escalation_failure_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (opened_by, idempotency_key)
);

CREATE INDEX support_incidents_queue_idx
  ON public.support_incidents (status, severity, opened_at DESC);

CREATE TABLE public.support_incident_tickets (
  incident_id UUID NOT NULL REFERENCES public.support_incidents(id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES public.support_tickets(id) ON DELETE RESTRICT,
  linked_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (incident_id, ticket_id)
);

CREATE TABLE public.support_incident_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES public.support_incidents(id) ON DELETE CASCADE,
  actor_admin_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (char_length(btrim(action)) BETWEEN 2 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_incident_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_incident_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Clients read own support tickets"
  ON public.support_tickets FOR SELECT TO authenticated
  USING (auth.uid() = client_id);
CREATE POLICY "Admins read support tickets"
  ON public.support_tickets FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY "Clients read own public support messages"
  ON public.support_ticket_messages FOR SELECT TO authenticated
  USING (
    visibility = 'client'
    AND EXISTS (
      SELECT 1 FROM public.support_tickets ticket
      WHERE ticket.id = support_ticket_messages.ticket_id
        AND auth.uid() = ticket.client_id
    )
  );
CREATE POLICY "Admins read all support messages"
  ON public.support_ticket_messages FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY "Admins read incidents"
  ON public.support_incidents FOR SELECT TO authenticated
  USING (public.is_admin());
CREATE POLICY "Admins read incident ticket links"
  ON public.support_incident_tickets FOR SELECT TO authenticated
  USING (public.is_admin());
CREATE POLICY "Admins read incident actions"
  ON public.support_incident_actions FOR SELECT TO authenticated
  USING (public.is_admin());

REVOKE ALL ON TABLE public.support_tickets FROM anon, authenticated;
REVOKE ALL ON TABLE public.support_ticket_messages FROM anon, authenticated;
REVOKE ALL ON TABLE public.support_incidents FROM anon, authenticated;
REVOKE ALL ON TABLE public.support_incident_tickets FROM anon, authenticated;
REVOKE ALL ON TABLE public.support_incident_actions FROM anon, authenticated;
REVOKE ALL ON TABLE private.support_operations_config FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.support_tickets TO authenticated;
GRANT SELECT ON public.support_ticket_messages TO authenticated;
GRANT SELECT ON public.support_incidents TO authenticated;
GRANT SELECT ON public.support_incident_tickets TO authenticated;
GRANT SELECT ON public.support_incident_actions TO authenticated;

CREATE FUNCTION public.create_support_ticket(
  _subject TEXT,
  _category TEXT,
  _description TEXT,
  _idempotency_key UUID
)
RETURNS TABLE (id UUID, status TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private
AS $$
DECLARE
  _actor UUID := auth.uid();
  _ticket public.support_tickets%ROWTYPE;
  _admin RECORD;
BEGIN
  IF _actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _actor AND role = 'client'
  ) THEN RAISE EXCEPTION 'client_required'; END IF;
  IF _idempotency_key IS NULL THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;
  IF char_length(btrim(COALESCE(_subject, ''))) NOT BETWEEN 4 AND 120 THEN RAISE EXCEPTION 'invalid_subject'; END IF;
  IF _category IS NULL OR _category NOT IN ('account', 'conversation', 'billing', 'privacy', 'technical', 'other') THEN RAISE EXCEPTION 'invalid_category'; END IF;
  IF char_length(btrim(COALESCE(_description, ''))) NOT BETWEEN 10 AND 4000 THEN RAISE EXCEPTION 'invalid_description'; END IF;

  INSERT INTO public.support_tickets (client_id, subject, category, description, idempotency_key)
  VALUES (_actor, btrim(_subject), _category, btrim(_description), _idempotency_key)
  ON CONFLICT (client_id, idempotency_key) DO NOTHING
  RETURNING * INTO _ticket;

  IF _ticket.id IS NULL THEN
    SELECT * INTO STRICT _ticket FROM public.support_tickets
    WHERE client_id = _actor AND idempotency_key = _idempotency_key;
  ELSE
    FOR _admin IN SELECT DISTINCT user_id FROM public.user_roles WHERE role = 'admin' LOOP
      PERFORM public.create_notification(
        _admin.user_id, 'support_ticket_new', 'פניית תמיכה חדשה',
        _ticket.subject, '/admin/support', NULL,
        jsonb_build_object('ticket_id', _ticket.id), 0
      );
    END LOOP;
  END IF;

  RETURN QUERY SELECT _ticket.id, _ticket.status, _ticket.created_at;
END;
$$;

CREATE FUNCTION public.add_support_ticket_message(
  _ticket_id UUID,
  _body TEXT,
  _idempotency_key UUID
)
RETURNS TABLE (id UUID, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private
AS $$
DECLARE
  _actor UUID := auth.uid();
  _ticket public.support_tickets%ROWTYPE;
  _message public.support_ticket_messages%ROWTYPE;
BEGIN
  SELECT * INTO _ticket FROM public.support_tickets
  WHERE support_tickets.id = _ticket_id AND client_id = _actor FOR UPDATE;
  IF _ticket.id IS NULL THEN RAISE EXCEPTION 'support_ticket_not_found'; END IF;
  IF _ticket.status = 'closed' THEN RAISE EXCEPTION 'support_ticket_closed'; END IF;
  IF _idempotency_key IS NULL THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;
  IF char_length(btrim(COALESCE(_body, ''))) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'invalid_message'; END IF;

  INSERT INTO public.support_ticket_messages
    (ticket_id, author_user_id, author_kind, visibility, body, idempotency_key)
  VALUES (_ticket.id, _actor, 'client', 'client', btrim(_body), _idempotency_key)
  ON CONFLICT (ticket_id, author_user_id, idempotency_key) DO NOTHING
  RETURNING * INTO _message;

  IF _message.id IS NULL THEN
    SELECT * INTO STRICT _message FROM public.support_ticket_messages
    WHERE ticket_id = _ticket.id AND author_user_id = _actor AND idempotency_key = _idempotency_key;
  ELSE
    UPDATE public.support_tickets
    SET status = CASE WHEN status = 'waiting_for_client' THEN 'in_progress' ELSE status END,
        version = version + 1, updated_at = clock_timestamp()
    WHERE support_tickets.id = _ticket.id;
  END IF;
  RETURN QUERY SELECT _message.id, _message.created_at;
END;
$$;

CREATE FUNCTION public.admin_update_support_ticket(
  _ticket_id UUID,
  _expected_version INTEGER,
  _status TEXT,
  _assignee_admin_id UUID
)
RETURNS TABLE (id UUID, status TEXT, assignee_admin_id UUID, version INTEGER, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private
AS $$
DECLARE
  _actor UUID := auth.uid();
  _updated public.support_tickets%ROWTYPE;
BEGIN
  IF _actor IS NULL OR public.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF _status NOT IN ('new', 'in_progress', 'waiting_for_client', 'closed') THEN RAISE EXCEPTION 'invalid_support_status'; END IF;
  IF _assignee_admin_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _assignee_admin_id AND role = 'admin'
  ) THEN RAISE EXCEPTION 'assignee_must_be_admin'; END IF;

  UPDATE public.support_tickets
  SET status = _status,
      assignee_admin_id = _assignee_admin_id,
      version = support_tickets.version + 1,
      closed_at = CASE WHEN _status = 'closed' THEN COALESCE(closed_at, clock_timestamp()) ELSE NULL END,
      updated_at = clock_timestamp()
  WHERE support_tickets.id = _ticket_id AND support_tickets.version = _expected_version
  RETURNING * INTO _updated;
  IF _updated.id IS NULL THEN RAISE EXCEPTION 'expected_version_mismatch'; END IF;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_actor, 'support.ticket.updated', 'support_ticket', _ticket_id::text,
    jsonb_build_object('status', _status, 'assignee_admin_id', _assignee_admin_id, 'version', _updated.version));
  RETURN QUERY SELECT _updated.id, _updated.status, _updated.assignee_admin_id, _updated.version, _updated.updated_at;
END;
$$;

CREATE FUNCTION public.admin_add_support_ticket_message(
  _ticket_id UUID,
  _body TEXT,
  _visibility TEXT,
  _idempotency_key UUID
)
RETURNS TABLE (id UUID, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private
AS $$
DECLARE
  _actor UUID := auth.uid();
  _ticket public.support_tickets%ROWTYPE;
  _message public.support_ticket_messages%ROWTYPE;
BEGIN
  IF _actor IS NULL OR public.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF _visibility NOT IN ('client', 'internal') THEN RAISE EXCEPTION 'invalid_visibility'; END IF;
  IF _idempotency_key IS NULL THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;
  IF char_length(btrim(COALESCE(_body, ''))) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'invalid_message'; END IF;
  SELECT * INTO _ticket FROM public.support_tickets WHERE support_tickets.id = _ticket_id FOR UPDATE;
  IF _ticket.id IS NULL THEN RAISE EXCEPTION 'support_ticket_not_found'; END IF;

  INSERT INTO public.support_ticket_messages
    (ticket_id, author_user_id, author_kind, visibility, body, idempotency_key)
  VALUES (_ticket_id, _actor, 'admin', _visibility, btrim(_body), _idempotency_key)
  ON CONFLICT (ticket_id, author_user_id, idempotency_key) DO NOTHING
  RETURNING * INTO _message;

  IF _message.id IS NULL THEN
    SELECT * INTO STRICT _message FROM public.support_ticket_messages
    WHERE ticket_id = _ticket_id AND author_user_id = _actor AND idempotency_key = _idempotency_key;
  ELSE
    UPDATE public.support_tickets
    SET status = CASE WHEN _visibility = 'client' THEN 'waiting_for_client' ELSE status END,
        version = version + 1, updated_at = clock_timestamp()
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

CREATE FUNCTION public.get_public_support_contact()
RETURNS TEXT
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, private
AS $$ SELECT config.public_support_contact FROM private.support_operations_config config WHERE singleton $$;

CREATE FUNCTION public.get_support_operations_config()
RETURNS TABLE (
  public_support_contact TEXT,
  business_owner_admin_id UUID,
  deputy_admin_id UUID,
  technical_contact TEXT,
  escalation_channel TEXT,
  support_hours TEXT,
  version INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, private
AS $$
BEGIN
  IF public.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'admin_required'; END IF;
  RETURN QUERY SELECT config.public_support_contact, config.business_owner_admin_id,
    config.deputy_admin_id, config.technical_contact, config.escalation_channel,
    config.support_hours, config.version
  FROM private.support_operations_config config WHERE singleton;
END;
$$;

CREATE FUNCTION public.admin_set_support_operations_config(
  _expected_version INTEGER,
  _public_support_contact TEXT,
  _business_owner_admin_id UUID,
  _deputy_admin_id UUID,
  _technical_contact TEXT,
  _escalation_channel TEXT,
  _support_hours TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private
AS $$
DECLARE _actor UUID := auth.uid(); _version INTEGER;
BEGIN
  IF _actor IS NULL OR public.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF _business_owner_admin_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _business_owner_admin_id AND role = 'admin') THEN RAISE EXCEPTION 'business_owner_must_be_admin'; END IF;
  IF _deputy_admin_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _deputy_admin_id AND role = 'admin') THEN RAISE EXCEPTION 'deputy_must_be_admin'; END IF;
  IF GREATEST(char_length(COALESCE(_public_support_contact, '')), char_length(COALESCE(_technical_contact, '')), char_length(COALESCE(_escalation_channel, '')), char_length(COALESCE(_support_hours, ''))) > 300 THEN RAISE EXCEPTION 'support_config_value_too_long'; END IF;
  UPDATE private.support_operations_config
  SET public_support_contact = NULLIF(btrim(_public_support_contact), ''),
      business_owner_admin_id = _business_owner_admin_id,
      deputy_admin_id = _deputy_admin_id,
      technical_contact = NULLIF(btrim(_technical_contact), ''),
      escalation_channel = NULLIF(btrim(_escalation_channel), ''),
      support_hours = NULLIF(btrim(_support_hours), ''),
      version = version + 1, updated_by = _actor, updated_at = clock_timestamp()
  WHERE singleton AND version = _expected_version RETURNING version INTO _version;
  IF _version IS NULL THEN RAISE EXCEPTION 'expected_version_mismatch'; END IF;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_actor, 'support.operations_config.updated', 'support_operations_config', 'singleton',
    jsonb_build_object('version', _version, 'public_contact_configured', NULLIF(btrim(_public_support_contact), '') IS NOT NULL,
      'business_owner_configured', _business_owner_admin_id IS NOT NULL, 'deputy_configured', _deputy_admin_id IS NOT NULL,
      'technical_contact_configured', NULLIF(btrim(_technical_contact), '') IS NOT NULL,
      'escalation_channel_configured', NULLIF(btrim(_escalation_channel), '') IS NOT NULL));
  RETURN _version;
END;
$$;

CREATE FUNCTION public.admin_create_support_incident(
  _incident_type TEXT,
  _severity TEXT,
  _title TEXT,
  _details TEXT,
  _owner_admin_id UUID,
  _ticket_ids UUID[],
  _idempotency_key UUID
)
RETURNS TABLE (id UUID, status TEXT, escalation_status TEXT, version INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private
AS $$
DECLARE
  _actor UUID := auth.uid(); _incident public.support_incidents%ROWTYPE;
  _config private.support_operations_config%ROWTYPE; _admin RECORD; _ticket UUID;
BEGIN
  IF _actor IS NULL OR public.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF _incident_type NOT IN ('outage', 'suspected_data_leak', 'incorrect_charge', 'significant_authorization_failure') THEN RAISE EXCEPTION 'invalid_incident_type'; END IF;
  IF _severity NOT IN ('medium', 'high', 'critical') THEN RAISE EXCEPTION 'invalid_incident_severity'; END IF;
  IF char_length(btrim(COALESCE(_title, ''))) NOT BETWEEN 4 AND 160 OR char_length(btrim(COALESCE(_details, ''))) NOT BETWEEN 10 AND 4000 THEN RAISE EXCEPTION 'invalid_incident_content'; END IF;
  IF _owner_admin_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _owner_admin_id AND role = 'admin') THEN RAISE EXCEPTION 'owner_must_be_admin'; END IF;
  SELECT * INTO STRICT _config FROM private.support_operations_config WHERE singleton;
  INSERT INTO public.support_incidents
    (incident_type, severity, title, details, owner_admin_id, opened_by, idempotency_key, escalation_status)
  VALUES (_incident_type, _severity, btrim(_title), btrim(_details), _owner_admin_id, _actor, _idempotency_key,
    CASE WHEN _config.business_owner_admin_id IS NULL OR _config.deputy_admin_id IS NULL OR _config.technical_contact IS NULL OR _config.escalation_channel IS NULL
      THEN 'pending_configuration' ELSE 'pending_delivery' END)
  ON CONFLICT (opened_by, idempotency_key) DO NOTHING RETURNING * INTO _incident;
  IF _incident.id IS NULL THEN
    SELECT * INTO STRICT _incident FROM public.support_incidents WHERE opened_by = _actor AND idempotency_key = _idempotency_key;
    RETURN QUERY SELECT _incident.id, _incident.status, _incident.escalation_status, _incident.version; RETURN;
  END IF;
  FOREACH _ticket IN ARRAY COALESCE(_ticket_ids, ARRAY[]::UUID[]) LOOP
    IF NOT EXISTS (SELECT 1 FROM public.support_tickets WHERE support_tickets.id = _ticket) THEN RAISE EXCEPTION 'support_ticket_not_found'; END IF;
    INSERT INTO public.support_incident_tickets (incident_id, ticket_id, linked_by) VALUES (_incident.id, _ticket, _actor) ON CONFLICT DO NOTHING;
  END LOOP;
  FOR _admin IN SELECT DISTINCT user_id FROM public.user_roles WHERE role = 'admin' LOOP
    PERFORM public.create_notification(_admin.user_id, 'support_incident_opened', 'אירוע קריטי נפתח',
      _incident.title, '/admin/support', NULL, jsonb_build_object('incident_id', _incident.id, 'severity', _severity), 0);
  END LOOP;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_actor, 'support.incident.opened', 'support_incident', _incident.id::text,
    jsonb_build_object('type', _incident_type, 'severity', _severity, 'escalation_status', _incident.escalation_status));
  RETURN QUERY SELECT _incident.id, _incident.status, _incident.escalation_status, _incident.version;
END;
$$;

CREATE FUNCTION public.admin_update_support_incident(
  _incident_id UUID,
  _expected_version INTEGER,
  _status TEXT,
  _owner_admin_id UUID,
  _action TEXT DEFAULT NULL
)
RETURNS TABLE (id UUID, status TEXT, version INTEGER, acknowledged_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private
AS $$
DECLARE _actor UUID := auth.uid(); _updated public.support_incidents%ROWTYPE;
BEGIN
  IF _actor IS NULL OR public.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF _status NOT IN ('open', 'acknowledged', 'resolved') THEN RAISE EXCEPTION 'invalid_incident_status'; END IF;
  IF _owner_admin_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _owner_admin_id AND role = 'admin') THEN RAISE EXCEPTION 'owner_must_be_admin'; END IF;
  IF _action IS NOT NULL AND char_length(btrim(_action)) NOT BETWEEN 2 AND 1000 THEN RAISE EXCEPTION 'invalid_incident_action'; END IF;
  UPDATE public.support_incidents SET status = _status, owner_admin_id = _owner_admin_id,
    acknowledged_at = CASE WHEN _status IN ('acknowledged', 'resolved') THEN COALESCE(acknowledged_at, clock_timestamp()) ELSE acknowledged_at END,
    resolved_at = CASE WHEN _status = 'resolved' THEN COALESCE(resolved_at, clock_timestamp()) ELSE NULL END,
    version = support_incidents.version + 1, updated_at = clock_timestamp()
  WHERE support_incidents.id = _incident_id AND support_incidents.version = _expected_version
  RETURNING * INTO _updated;
  IF _updated.id IS NULL THEN RAISE EXCEPTION 'expected_version_mismatch'; END IF;
  IF _action IS NOT NULL THEN INSERT INTO public.support_incident_actions (incident_id, actor_admin_id, action) VALUES (_incident_id, _actor, btrim(_action)); END IF;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_actor, 'support.incident.updated', 'support_incident', _incident_id::text,
    jsonb_build_object('status', _status, 'owner_admin_id', _owner_admin_id, 'version', _updated.version));
  RETURN QUERY SELECT _updated.id, _updated.status, _updated.version, _updated.acknowledged_at, _updated.resolved_at;
END;
$$;

CREATE FUNCTION public.admin_record_support_incident_delivery(
  _incident_id UUID,
  _expected_version INTEGER,
  _delivery_status TEXT,
  _failure_code TEXT DEFAULT NULL
)
RETURNS TABLE (id UUID, escalation_status TEXT, version INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private
AS $$
DECLARE _actor UUID := auth.uid(); _updated public.support_incidents%ROWTYPE;
BEGIN
  IF _actor IS NULL OR public.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF _delivery_status NOT IN ('pending_delivery', 'delivered', 'failed') THEN RAISE EXCEPTION 'invalid_delivery_status'; END IF;
  UPDATE public.support_incidents SET escalation_status = _delivery_status,
    escalation_failure_code = CASE WHEN _delivery_status = 'failed' THEN NULLIF(left(COALESCE(_failure_code, 'unspecified'), 120), '') ELSE NULL END,
    version = support_incidents.version + 1, updated_at = clock_timestamp()
  WHERE support_incidents.id = _incident_id AND support_incidents.version = _expected_version
  RETURNING * INTO _updated;
  IF _updated.id IS NULL THEN RAISE EXCEPTION 'expected_version_mismatch'; END IF;
  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_actor, 'support.incident.delivery_recorded', 'support_incident', _incident_id::text,
    jsonb_build_object('delivery_status', _delivery_status, 'failure_code', _updated.escalation_failure_code));
  RETURN QUERY SELECT _updated.id, _updated.escalation_status, _updated.version;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_support_ticket(TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.add_support_ticket_message(UUID, TEXT, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_update_support_ticket(UUID, INTEGER, TEXT, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_add_support_ticket_message(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_public_support_contact() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_support_operations_config() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_set_support_operations_config(INTEGER, TEXT, UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_create_support_incident(TEXT, TEXT, TEXT, TEXT, UUID, UUID[], UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_update_support_incident(UUID, INTEGER, TEXT, UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_record_support_incident_delivery(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_support_ticket(TEXT, TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_support_ticket_message(UUID, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_support_ticket(UUID, INTEGER, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_add_support_ticket_message(UUID, TEXT, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_support_contact() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_support_operations_config() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_support_operations_config(INTEGER, TEXT, UUID, UUID, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_support_incident(TEXT, TEXT, TEXT, TEXT, UUID, UUID[], UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_support_incident(UUID, INTEGER, TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_record_support_incident_delivery(UUID, INTEGER, TEXT, TEXT) TO authenticated;

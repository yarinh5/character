-- P06 first human response target. Windows are interpreted in their configured
-- IANA timezone. Cross-midnight windows belong to their opening weekday.

CREATE FUNCTION private.support_schedule_windows_valid(_windows JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $$
DECLARE _window JSONB;
BEGIN
  IF _windows IS NULL OR jsonb_typeof(_windows) <> 'array'
    OR jsonb_array_length(_windows) = 0 THEN
    RETURN FALSE;
  END IF;
  FOR _window IN SELECT value FROM jsonb_array_elements(_windows) LOOP
    IF jsonb_typeof(_window) <> 'object'
      OR jsonb_typeof(_window -> 'weekday') <> 'number'
      OR (_window ->> 'weekday') !~ '^[0-6]$'
      OR COALESCE(_window ->> 'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      OR COALESCE(_window ->> 'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      OR (_window ->> 'start') = (_window ->> 'end') THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

CREATE FUNCTION private.calculate_support_first_response_target(
  _received_at TIMESTAMPTZ,
  _timezone TEXT,
  _windows JSONB,
  _closure_dates DATE[]
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, private, pg_temp
AS $$
DECLARE
  _local_received TIMESTAMP;
  _opening_date DATE;
  _inside_opening_date DATE;
  _candidate_date DATE;
  _window JSONB;
  _start_time TIME;
  _end_time TIME;
  _start_local TIMESTAMP;
  _end_local TIMESTAMP;
  _start_at TIMESTAMPTZ;
  _end_at TIMESTAMPTZ;
  _day_end TIMESTAMPTZ;
  _day_has_future_window BOOLEAN;
  _offset INTEGER;
BEGIN
  IF _received_at IS NULL OR NULLIF(btrim(_timezone), '') IS NULL
    OR private.support_schedule_windows_valid(_windows) IS NOT TRUE
    OR NOT EXISTS (SELECT 1 FROM pg_timezone_names zone WHERE zone.name = _timezone) THEN
    RETURN NULL;
  END IF;

  _local_received := _received_at AT TIME ZONE _timezone;
  FOR _offset IN 0..1 LOOP
    _opening_date := _local_received::DATE - _offset;
    IF _opening_date = ANY(COALESCE(_closure_dates, ARRAY[]::DATE[])) THEN CONTINUE; END IF;
    FOR _window IN
      SELECT value FROM jsonb_array_elements(_windows)
      WHERE (value ->> 'weekday')::INTEGER = EXTRACT(DOW FROM _opening_date)::INTEGER
    LOOP
      _start_time := (_window ->> 'start')::TIME;
      _end_time := (_window ->> 'end')::TIME;
      _start_local := _opening_date + _start_time;
      _end_local := _opening_date + _end_time
        + CASE WHEN _end_time <= _start_time THEN INTERVAL '1 day' ELSE INTERVAL '0' END;
      _start_at := _start_local AT TIME ZONE _timezone;
      _end_at := _end_local AT TIME ZONE _timezone;
      IF _received_at >= _start_at AND _received_at < _end_at THEN
        _inside_opening_date := _opening_date;
        EXIT;
      END IF;
    END LOOP;
    IF _inside_opening_date IS NOT NULL THEN EXIT; END IF;
  END LOOP;

  -- A bounded 371-day scan covers a full annual schedule plus its next day.
  FOR _offset IN 0..370 LOOP
    _candidate_date := COALESCE(_inside_opening_date + 1, _local_received::DATE) + _offset;
    IF _candidate_date = ANY(COALESCE(_closure_dates, ARRAY[]::DATE[])) THEN CONTINUE; END IF;
    _day_end := NULL;
    _day_has_future_window := _inside_opening_date IS NOT NULL OR _offset > 0;
    FOR _window IN
      SELECT value FROM jsonb_array_elements(_windows)
      WHERE (value ->> 'weekday')::INTEGER = EXTRACT(DOW FROM _candidate_date)::INTEGER
    LOOP
      _start_time := (_window ->> 'start')::TIME;
      _end_time := (_window ->> 'end')::TIME;
      _start_local := _candidate_date + _start_time;
      _end_local := _candidate_date + _end_time
        + CASE WHEN _end_time <= _start_time THEN INTERVAL '1 day' ELSE INTERVAL '0' END;
      _start_at := _start_local AT TIME ZONE _timezone;
      _end_at := _end_local AT TIME ZONE _timezone;
      IF _inside_opening_date IS NULL AND _offset = 0 AND _start_at >= _received_at THEN
        _day_has_future_window := TRUE;
      END IF;
      IF _day_end IS NULL OR _end_at > _day_end THEN _day_end := _end_at; END IF;
    END LOOP;
    IF _day_end IS NOT NULL AND _day_has_future_window THEN RETURN _day_end; END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

ALTER TABLE private.support_operations_config
  ADD COLUMN support_windows JSONB,
  ADD COLUMN support_closure_dates DATE[],
  ADD COLUMN support_schedule_version INTEGER NOT NULL DEFAULT 1 CHECK (support_schedule_version > 0);

UPDATE private.support_operations_config config
SET support_windows = (
      SELECT jsonb_agg(jsonb_build_object(
        'weekday', weekday,
        'start', to_char(config.support_day_start, 'HH24:MI'),
        'end', to_char(config.support_day_end, 'HH24:MI')
      ) ORDER BY weekday)
      FROM unnest(config.support_weekdays) weekday
    ),
    support_closure_dates = ARRAY[]::DATE[]
WHERE config.support_timezone IS NOT NULL
  AND config.support_weekdays IS NOT NULL
  AND config.support_day_start IS NOT NULL
  AND config.support_day_end IS NOT NULL;

ALTER TABLE private.support_operations_config
  ADD CONSTRAINT support_windows_shape CHECK (
    (support_timezone IS NULL AND support_windows IS NULL AND support_closure_dates IS NULL)
    OR
    (support_timezone IS NOT NULL
      AND private.support_schedule_windows_valid(support_windows)
      AND support_closure_dates IS NOT NULL)
  );

ALTER TABLE public.support_tickets
  ADD COLUMN first_response_target_at TIMESTAMPTZ,
  ADD COLUMN first_response_schedule_version INTEGER,
  ADD COLUMN first_response_timezone TEXT,
  ADD COLUMN first_human_response_at TIMESTAMPTZ,
  ADD COLUMN first_response_within_target BOOLEAN,
  ADD CONSTRAINT support_first_response_target_snapshot CHECK (
    (first_response_target_at IS NULL
      AND first_response_schedule_version IS NULL
      AND first_response_timezone IS NULL)
    OR
    (first_response_target_at IS NOT NULL
      AND first_response_schedule_version IS NOT NULL
      AND first_response_timezone IS NOT NULL)
  ),
  ADD CONSTRAINT support_first_response_outcome_shape CHECK (
    (first_human_response_at IS NULL AND first_response_within_target IS NULL)
    OR first_human_response_at IS NOT NULL
  );

CREATE INDEX support_tickets_first_response_queue_idx
  ON public.support_tickets (first_response_target_at, created_at)
  WHERE first_human_response_at IS NULL;

CREATE FUNCTION public.get_support_operations_config_v3()
RETURNS TABLE (
  public_support_contact TEXT,
  business_owner_admin_id UUID,
  deputy_admin_id UUID,
  technical_contact TEXT,
  escalation_channel TEXT,
  support_timezone TEXT,
  support_windows JSONB,
  support_closure_dates DATE[],
  support_schedule_version INTEGER,
  schedule_state TEXT,
  escalation_adapter_state TEXT,
  version INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF public.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'admin_required'; END IF;
  RETURN QUERY
  SELECT config.public_support_contact, config.business_owner_admin_id,
    config.deputy_admin_id, config.technical_contact, config.escalation_channel,
    config.support_timezone, config.support_windows, config.support_closure_dates,
    config.support_schedule_version,
    CASE WHEN config.support_timezone IS NOT NULL
      AND private.support_schedule_windows_valid(config.support_windows)
      AND config.support_closure_dates IS NOT NULL
      THEN 'configured_not_verified' ELSE 'not_configured' END,
    config.escalation_adapter_state, config.version
  FROM private.support_operations_config config WHERE config.singleton;
END;
$$;

CREATE FUNCTION public.admin_set_support_operations_config_v3(
  _expected_version INTEGER,
  _public_support_contact TEXT,
  _business_owner_admin_id UUID,
  _deputy_admin_id UUID,
  _technical_contact TEXT,
  _escalation_channel TEXT,
  _support_timezone TEXT,
  _support_windows JSONB,
  _support_closure_dates DATE[]
)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE
  _actor UUID := auth.uid();
  _version INTEGER;
  _schedule_any BOOLEAN := _support_timezone IS NOT NULL OR _support_windows IS NOT NULL
    OR _support_closure_dates IS NOT NULL;
  _normalized_closures DATE[];
BEGIN
  IF _actor IS NULL OR public.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF _business_owner_admin_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _business_owner_admin_id AND role = 'admin'
  ) THEN RAISE EXCEPTION 'business_owner_must_be_admin'; END IF;
  IF _deputy_admin_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _deputy_admin_id AND role = 'admin'
  ) THEN RAISE EXCEPTION 'deputy_must_be_admin'; END IF;
  IF GREATEST(char_length(COALESCE(_public_support_contact, '')),
      char_length(COALESCE(_technical_contact, '')),
      char_length(COALESCE(_escalation_channel, ''))) > 300 THEN
    RAISE EXCEPTION 'support_config_value_too_long';
  END IF;
  IF _schedule_any AND (
    NULLIF(btrim(COALESCE(_support_timezone, '')), '') IS NULL
    OR private.support_schedule_windows_valid(_support_windows) IS NOT TRUE
  ) THEN RAISE EXCEPTION 'support_schedule_incomplete'; END IF;
  IF _schedule_any AND NOT EXISTS (
    SELECT 1 FROM pg_timezone_names zone WHERE zone.name = btrim(_support_timezone)
  ) THEN RAISE EXCEPTION 'support_timezone_invalid'; END IF;
  _normalized_closures := CASE WHEN _schedule_any THEN ARRAY(
    SELECT DISTINCT value FROM unnest(COALESCE(_support_closure_dates, ARRAY[]::DATE[])) value
    ORDER BY value
  ) ELSE NULL END;

  UPDATE private.support_operations_config
  SET public_support_contact = NULLIF(btrim(_public_support_contact), ''),
      business_owner_admin_id = _business_owner_admin_id,
      deputy_admin_id = _deputy_admin_id,
      technical_contact = NULLIF(btrim(_technical_contact), ''),
      escalation_channel = NULLIF(btrim(_escalation_channel), ''),
      support_timezone = CASE WHEN _schedule_any THEN btrim(_support_timezone) ELSE NULL END,
      support_windows = CASE WHEN _schedule_any THEN _support_windows ELSE NULL END,
      support_closure_dates = _normalized_closures,
      support_weekdays = NULL,
      support_day_start = NULL,
      support_day_end = NULL,
      support_hours = NULL,
      support_schedule_version = CASE WHEN
        support_timezone IS DISTINCT FROM CASE WHEN _schedule_any THEN btrim(_support_timezone) ELSE NULL END
        OR support_windows IS DISTINCT FROM CASE WHEN _schedule_any THEN _support_windows ELSE NULL END
        OR support_closure_dates IS DISTINCT FROM _normalized_closures
        THEN support_schedule_version + 1 ELSE support_schedule_version END,
      escalation_adapter_state = CASE WHEN
        business_owner_admin_id IS DISTINCT FROM _business_owner_admin_id
        OR deputy_admin_id IS DISTINCT FROM _deputy_admin_id
        OR technical_contact IS DISTINCT FROM NULLIF(btrim(_technical_contact), '')
        OR escalation_channel IS DISTINCT FROM NULLIF(btrim(_escalation_channel), '')
        THEN CASE WHEN escalation_adapter_state = 'not_configured'
          THEN 'not_configured' ELSE 'configured_not_verified' END
        ELSE escalation_adapter_state END,
      escalation_adapter_verified_at = CASE WHEN
        business_owner_admin_id IS DISTINCT FROM _business_owner_admin_id
        OR deputy_admin_id IS DISTINCT FROM _deputy_admin_id
        OR technical_contact IS DISTINCT FROM NULLIF(btrim(_technical_contact), '')
        OR escalation_channel IS DISTINCT FROM NULLIF(btrim(_escalation_channel), '')
        THEN NULL ELSE escalation_adapter_verified_at END,
      escalation_adapter_evidence_hash = CASE WHEN
        business_owner_admin_id IS DISTINCT FROM _business_owner_admin_id
        OR deputy_admin_id IS DISTINCT FROM _deputy_admin_id
        OR technical_contact IS DISTINCT FROM NULLIF(btrim(_technical_contact), '')
        OR escalation_channel IS DISTINCT FROM NULLIF(btrim(_escalation_channel), '')
        THEN NULL ELSE escalation_adapter_evidence_hash END,
      version = version + 1,
      updated_by = _actor,
      updated_at = clock_timestamp()
  WHERE singleton AND version = _expected_version
  RETURNING version INTO _version;
  IF _version IS NULL THEN RAISE EXCEPTION 'expected_version_mismatch'; END IF;

  INSERT INTO public.audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
  SELECT _actor, 'support.operations_config.updated', 'support_operations_config', 'singleton',
    jsonb_build_object(
      'version', config.version,
      'support_schedule_version', config.support_schedule_version,
      'support_schedule_configured', config.support_windows IS NOT NULL,
      'support_window_count', COALESCE(jsonb_array_length(config.support_windows), 0),
      'support_closure_count', COALESCE(cardinality(config.support_closure_dates), 0),
      'public_contact_configured', config.public_support_contact IS NOT NULL,
      'business_owner_configured', config.business_owner_admin_id IS NOT NULL,
      'deputy_configured', config.deputy_admin_id IS NOT NULL,
      'technical_contact_configured', config.technical_contact IS NOT NULL,
      'escalation_channel_configured', config.escalation_channel IS NOT NULL)
  FROM private.support_operations_config config WHERE config.singleton;
  RETURN _version;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_support_ticket(
  _subject TEXT,
  _category TEXT,
  _description TEXT,
  _idempotency_key UUID
)
RETURNS TABLE (id UUID, status TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE
  _actor UUID := auth.uid();
  _ticket public.support_tickets%ROWTYPE;
  _admin RECORD;
  _config private.support_operations_config%ROWTYPE;
  _received_at TIMESTAMPTZ := clock_timestamp();
  _target_at TIMESTAMPTZ;
BEGIN
  IF _actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _actor AND role = 'client'
  ) THEN RAISE EXCEPTION 'client_required'; END IF;
  IF _idempotency_key IS NULL THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;
  IF char_length(btrim(COALESCE(_subject, ''))) NOT BETWEEN 4 AND 120 THEN RAISE EXCEPTION 'invalid_subject'; END IF;
  IF _category IS NULL OR _category NOT IN ('account', 'conversation', 'billing', 'privacy', 'technical', 'other') THEN RAISE EXCEPTION 'invalid_category'; END IF;
  IF char_length(btrim(COALESCE(_description, ''))) NOT BETWEEN 10 AND 4000 THEN RAISE EXCEPTION 'invalid_description'; END IF;

  SELECT * INTO STRICT _config FROM private.support_operations_config WHERE singleton FOR SHARE;
  _target_at := private.calculate_support_first_response_target(
    _received_at, _config.support_timezone, _config.support_windows, _config.support_closure_dates
  );
  INSERT INTO public.support_tickets (
    client_id, subject, category, description, idempotency_key, created_at,
    first_response_target_at, first_response_schedule_version, first_response_timezone
  ) VALUES (
    _actor, btrim(_subject), _category, btrim(_description), _idempotency_key, _received_at,
    _target_at,
    CASE WHEN _target_at IS NOT NULL THEN _config.support_schedule_version ELSE NULL END,
    CASE WHEN _target_at IS NOT NULL THEN _config.support_timezone ELSE NULL END
  )
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
  _response_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF _actor IS NULL OR public.is_admin() IS NOT TRUE THEN RAISE EXCEPTION 'admin_required'; END IF;
  IF _visibility NOT IN ('client', 'internal') THEN RAISE EXCEPTION 'invalid_visibility'; END IF;
  IF _idempotency_key IS NULL THEN RAISE EXCEPTION 'idempotency_key_required'; END IF;
  IF char_length(btrim(COALESCE(_body, ''))) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'invalid_message'; END IF;
  SELECT * INTO _ticket FROM public.support_tickets WHERE support_tickets.id = _ticket_id FOR UPDATE;
  IF _ticket.id IS NULL THEN RAISE EXCEPTION 'support_ticket_not_found'; END IF;

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

REVOKE ALL ON FUNCTION private.support_schedule_windows_valid(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.calculate_support_first_response_target(TIMESTAMPTZ, TEXT, JSONB, DATE[])
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_support_operations_config_v3() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_set_support_operations_config_v3(
  INTEGER, TEXT, UUID, UUID, TEXT, TEXT, TEXT, JSONB, DATE[]
) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_set_support_operations_config_v2(
  INTEGER, TEXT, UUID, UUID, TEXT, TEXT, TEXT, SMALLINT[], TIME, TIME
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_support_operations_config_v3() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_support_operations_config_v3(
  INTEGER, TEXT, UUID, UUID, TEXT, TEXT, TEXT, JSONB, DATE[]
) TO authenticated;

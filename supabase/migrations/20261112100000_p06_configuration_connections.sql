-- P06 configuration connections. Values remain empty until an authorized
-- operator supplies them; recipient fields never prove external delivery.

ALTER TABLE private.support_operations_config
  ADD COLUMN support_timezone TEXT,
  ADD COLUMN support_weekdays SMALLINT[],
  ADD COLUMN support_day_start TIME,
  ADD COLUMN support_day_end TIME,
  ADD COLUMN escalation_adapter_state TEXT NOT NULL DEFAULT 'not_configured'
    CHECK (escalation_adapter_state IN ('not_configured', 'configured_not_verified', 'verified')),
  ADD COLUMN escalation_adapter_verified_at TIMESTAMPTZ,
  ADD COLUMN escalation_adapter_evidence_hash TEXT,
  ADD CONSTRAINT support_schedule_all_or_none CHECK (
    (support_timezone IS NULL AND support_weekdays IS NULL
      AND support_day_start IS NULL AND support_day_end IS NULL)
    OR
    (support_timezone IS NOT NULL AND support_weekdays IS NOT NULL
      AND cardinality(support_weekdays) > 0
      AND support_weekdays <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[]
      AND support_day_start IS NOT NULL AND support_day_end IS NOT NULL
      AND support_day_start < support_day_end)
  ),
  ADD CONSTRAINT support_adapter_evidence_shape CHECK (
    (escalation_adapter_state <> 'verified'
      AND escalation_adapter_verified_at IS NULL
      AND escalation_adapter_evidence_hash IS NULL)
    OR
    (escalation_adapter_state = 'verified'
      AND escalation_adapter_verified_at IS NOT NULL
      AND escalation_adapter_evidence_hash ~ '^[0-9a-f]{64}$')
  );

CREATE FUNCTION public.get_support_operations_config_v2()
RETURNS TABLE (
  public_support_contact TEXT,
  business_owner_admin_id UUID,
  deputy_admin_id UUID,
  technical_contact TEXT,
  escalation_channel TEXT,
  support_timezone TEXT,
  support_weekdays SMALLINT[],
  support_day_start TIME,
  support_day_end TIME,
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
    config.support_timezone, config.support_weekdays, config.support_day_start,
    config.support_day_end,
    CASE WHEN config.support_timezone IS NOT NULL THEN 'configured_not_verified'
      ELSE 'not_configured' END,
    config.escalation_adapter_state, config.version
  FROM private.support_operations_config config
  WHERE config.singleton;
END;
$$;

CREATE FUNCTION public.admin_set_support_operations_config_v2(
  _expected_version INTEGER,
  _public_support_contact TEXT,
  _business_owner_admin_id UUID,
  _deputy_admin_id UUID,
  _technical_contact TEXT,
  _escalation_channel TEXT,
  _support_timezone TEXT,
  _support_weekdays SMALLINT[],
  _support_day_start TIME,
  _support_day_end TIME
)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE
  _actor UUID := auth.uid();
  _version INTEGER;
  _schedule_any BOOLEAN := _support_timezone IS NOT NULL OR _support_weekdays IS NOT NULL
    OR _support_day_start IS NOT NULL OR _support_day_end IS NOT NULL;
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
    OR _support_weekdays IS NULL OR cardinality(_support_weekdays) = 0
    OR NOT (_support_weekdays <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[])
    OR _support_day_start IS NULL OR _support_day_end IS NULL
    OR _support_day_start >= _support_day_end
  ) THEN RAISE EXCEPTION 'support_schedule_incomplete'; END IF;
  IF _schedule_any AND NOT EXISTS (
    SELECT 1 FROM pg_timezone_names zone WHERE zone.name = btrim(_support_timezone)
  ) THEN RAISE EXCEPTION 'support_timezone_invalid'; END IF;

  UPDATE private.support_operations_config
  SET public_support_contact = NULLIF(btrim(_public_support_contact), ''),
      business_owner_admin_id = _business_owner_admin_id,
      deputy_admin_id = _deputy_admin_id,
      technical_contact = NULLIF(btrim(_technical_contact), ''),
      escalation_channel = NULLIF(btrim(_escalation_channel), ''),
      support_timezone = CASE WHEN _schedule_any THEN btrim(_support_timezone) ELSE NULL END,
      support_weekdays = CASE WHEN _schedule_any THEN _support_weekdays ELSE NULL END,
      support_day_start = CASE WHEN _schedule_any THEN _support_day_start ELSE NULL END,
      support_day_end = CASE WHEN _schedule_any THEN _support_day_end ELSE NULL END,
      support_hours = NULL,
      escalation_adapter_state = CASE
        WHEN business_owner_admin_id IS DISTINCT FROM _business_owner_admin_id
          OR deputy_admin_id IS DISTINCT FROM _deputy_admin_id
          OR technical_contact IS DISTINCT FROM NULLIF(btrim(_technical_contact), '')
          OR escalation_channel IS DISTINCT FROM NULLIF(btrim(_escalation_channel), '')
        THEN CASE WHEN escalation_adapter_state = 'not_configured'
          THEN 'not_configured' ELSE 'configured_not_verified' END
        ELSE escalation_adapter_state END,
      escalation_adapter_verified_at = CASE
        WHEN business_owner_admin_id IS DISTINCT FROM _business_owner_admin_id
          OR deputy_admin_id IS DISTINCT FROM _deputy_admin_id
          OR technical_contact IS DISTINCT FROM NULLIF(btrim(_technical_contact), '')
          OR escalation_channel IS DISTINCT FROM NULLIF(btrim(_escalation_channel), '')
        THEN NULL ELSE escalation_adapter_verified_at END,
      escalation_adapter_evidence_hash = CASE
        WHEN business_owner_admin_id IS DISTINCT FROM _business_owner_admin_id
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
  VALUES (_actor, 'support.operations_config.updated', 'support_operations_config', 'singleton',
    jsonb_build_object(
      'version', _version,
      'public_contact_configured', NULLIF(btrim(_public_support_contact), '') IS NOT NULL,
      'business_owner_configured', _business_owner_admin_id IS NOT NULL,
      'deputy_configured', _deputy_admin_id IS NOT NULL,
      'technical_contact_configured', NULLIF(btrim(_technical_contact), '') IS NOT NULL,
      'escalation_channel_configured', NULLIF(btrim(_escalation_channel), '') IS NOT NULL,
      'support_schedule_configured', _schedule_any));
  RETURN _version;
END;
$$;

CREATE FUNCTION public.record_support_escalation_adapter_state_for_server(
  _state TEXT,
  _evidence_hash TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE _version INTEGER;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  IF _state NOT IN ('not_configured', 'configured_not_verified', 'verified') THEN
    RAISE EXCEPTION 'invalid_adapter_state';
  END IF;
  IF _state = 'verified' AND COALESCE(_evidence_hash, '') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'adapter_evidence_required';
  END IF;
  UPDATE private.support_operations_config
  SET escalation_adapter_state = _state,
      escalation_adapter_verified_at = CASE WHEN _state = 'verified' THEN clock_timestamp() ELSE NULL END,
      escalation_adapter_evidence_hash = CASE WHEN _state = 'verified' THEN lower(_evidence_hash) ELSE NULL END,
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE singleton
  RETURNING version INTO _version;
  RETURN _version;
END;
$$;

CREATE FUNCTION private.enforce_support_incident_delivery_configuration()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE _adapter_state TEXT;
BEGIN
  SELECT escalation_adapter_state INTO STRICT _adapter_state
  FROM private.support_operations_config WHERE singleton;
  IF _adapter_state <> 'verified' AND NEW.escalation_status IN ('pending_delivery', 'delivered') THEN
    NEW.escalation_status := 'pending_configuration';
    NEW.escalation_failure_code := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER support_incident_delivery_configuration_guard
BEFORE INSERT OR UPDATE OF escalation_status ON public.support_incidents
FOR EACH ROW EXECUTE FUNCTION private.enforce_support_incident_delivery_configuration();

REVOKE EXECUTE ON FUNCTION public.get_support_operations_config_v2() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.admin_set_support_operations_config_v2(
  INTEGER, TEXT, UUID, UUID, TEXT, TEXT, TEXT, SMALLINT[], TIME, TIME
) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.record_support_escalation_adapter_state_for_server(TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_record_support_incident_delivery(UUID, INTEGER, TEXT, TEXT)
  FROM authenticated;
REVOKE ALL ON FUNCTION private.enforce_support_incident_delivery_configuration()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_support_operations_config_v2() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_support_operations_config_v2(
  INTEGER, TEXT, UUID, UUID, TEXT, TEXT, TEXT, SMALLINT[], TIME, TIME
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_support_escalation_adapter_state_for_server(TEXT, TEXT)
  TO service_role;

-- Legal content is not active merely because a URL was inserted. Existing
-- rows become drafts and remain unusable until an authorized legal approval
-- workflow records the approver and reference in a later approved package.
ALTER TABLE public.client_consent_documents
  ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (lifecycle_status IN ('draft', 'approved', 'active', 'retired')),
  ADD COLUMN approved_at TIMESTAMPTZ,
  ADD COLUMN approved_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN approval_reference TEXT,
  ADD CONSTRAINT consent_approval_complete CHECK (
    lifecycle_status = 'draft'
    OR (approved_at IS NOT NULL AND approved_by IS NOT NULL
      AND NULLIF(btrim(approval_reference), '') IS NOT NULL)
  );

DROP POLICY IF EXISTS "Clients view active consent documents"
  ON public.client_consent_documents;
CREATE POLICY "Clients view approved active consent documents"
  ON public.client_consent_documents FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR (
      lifecycle_status = 'active'
      AND approved_at IS NOT NULL
      AND retired_at IS NULL
    )
  );

CREATE OR REPLACE FUNCTION private.has_required_client_consents(_client_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.client_consent_documents document
    WHERE document.required IS TRUE
      AND document.lifecycle_status = 'active'
      AND document.approved_at IS NOT NULL
      AND document.retired_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.client_consent_acceptances acceptance
        WHERE acceptance.client_id = _client_id AND acceptance.document_id = document.id
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.get_client_consent_requirements()
RETURNS TABLE (
  id UUID, consent_key TEXT, version TEXT, title TEXT,
  document_url TEXT, required BOOLEAN, accepted_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client UUID := auth.uid();
  _policy_enabled BOOLEAN := private.setting_bool('client_consent_policy_enabled', FALSE);
BEGIN
  IF _client IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT _policy_enabled THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.client_consent_documents document
    WHERE document.required IS TRUE
      AND document.lifecycle_status = 'active'
      AND document.approved_at IS NOT NULL
      AND document.retired_at IS NULL
  ) THEN RAISE EXCEPTION 'client_consent_policy_unconfigured'; END IF;
  RETURN QUERY
  SELECT document.id, document.consent_key, document.version, document.title,
    document.document_url, document.required, acceptance.accepted_at
  FROM public.client_consent_documents document
  LEFT JOIN public.client_consent_acceptances acceptance
    ON acceptance.client_id = _client AND acceptance.document_id = document.id
  WHERE document.lifecycle_status = 'active'
    AND document.approved_at IS NOT NULL
    AND document.retired_at IS NULL
  ORDER BY document.required DESC, document.consent_key, document.version;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_client_consent(_document_id UUID)
RETURNS TABLE (document_id UUID, accepted_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client UUID := auth.uid();
  _acceptance public.client_consent_acceptances%ROWTYPE;
BEGIN
  IF _client IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT private.setting_bool('client_consent_policy_enabled', FALSE) THEN
    RAISE EXCEPTION 'client_consent_policy_disabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.client_consent_documents document
    WHERE document.id = _document_id
      AND document.lifecycle_status = 'active'
      AND document.approved_at IS NOT NULL
      AND document.retired_at IS NULL
  ) THEN RAISE EXCEPTION 'client_consent_document_unavailable'; END IF;
  INSERT INTO public.client_consent_acceptances (client_id, document_id)
  VALUES (_client, _document_id)
  ON CONFLICT (client_id, document_id) DO UPDATE
    SET accepted_at = client_consent_acceptances.accepted_at
  RETURNING * INTO _acceptance;
  document_id := _acceptance.document_id;
  accepted_at := _acceptance.accepted_at;
  RETURN NEXT;
END;
$$;

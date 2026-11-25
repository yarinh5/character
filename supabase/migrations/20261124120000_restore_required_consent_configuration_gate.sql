CREATE OR REPLACE FUNCTION private.ensure_active_client(_user_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _mandatory_onboarding BOOLEAN := FALSE; _consent_policy_enabled BOOLEAN := FALSE;
BEGIN
  PERFORM private.ensure_recovery_business_open();
  IF private.account_deletion_blocks_business_activity(_user_id) OR NOT EXISTS (
    SELECT 1 FROM public.user_roles role JOIN public.profiles profile ON profile.user_id = role.user_id
    WHERE role.user_id = _user_id AND role.role = 'client'::public.app_role
      AND COALESCE(profile.status, 'active') = 'active'
      AND profile.deleted_at IS NULL AND profile.pii_archived_at IS NULL
  ) THEN RAISE EXCEPTION 'client_account_inactive'; END IF;
  IF EXISTS (SELECT 1 FROM private.registration_eligibility WHERE user_id = _user_id)
    AND NOT EXISTS (SELECT 1 FROM private.registration_eligibility WHERE user_id = _user_id AND activated_at IS NOT NULL)
  THEN RAISE EXCEPTION 'client_registration_not_eligible' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE((value #>> '{}')::BOOLEAN, FALSE) INTO _mandatory_onboarding
  FROM public.system_settings WHERE key = 'mandatory_onboarding_enabled';
  SELECT COALESCE((value #>> '{}')::BOOLEAN, FALSE) INTO _consent_policy_enabled
  FROM public.system_settings WHERE key = 'client_consent_policy_enabled';
  IF _consent_policy_enabled THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.client_consent_documents document
      WHERE document.required IS TRUE
        AND document.lifecycle_status = 'active'
        AND document.approved_at IS NOT NULL
        AND document.retired_at IS NULL
    ) THEN
      RAISE EXCEPTION 'client_consent_policy_unconfigured' USING ERRCODE = '42501';
    END IF;
    IF NOT private.has_required_client_consents(_user_id) THEN
      RAISE EXCEPTION 'client_consent_required' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF _mandatory_onboarding AND NOT EXISTS (
    SELECT 1 FROM public.client_profiles profile WHERE profile.user_id = _user_id
      AND profile.onboarding_completed_at IS NOT NULL
      AND COALESCE(profile.computed_age, profile.age) BETWEEN 18 AND 120
      AND NULLIF(btrim(profile.first_name), '') IS NOT NULL
      AND NULLIF(btrim(profile.last_name), '') IS NOT NULL
      AND profile.city_id IS NOT NULL AND NULLIF(btrim(profile.bio), '') IS NOT NULL
      AND profile.relationship_status IS NOT NULL AND profile.smoking_status IS NOT NULL
      AND profile.preferred_min_age IS NOT NULL AND profile.preferred_max_age IS NOT NULL
      AND profile.preferred_distance_km IS NOT NULL
      AND jsonb_array_length(profile.content_preferences) > 0
      AND jsonb_array_length(profile.character_preferences) > 0
  ) THEN RAISE EXCEPTION 'client_onboarding_required' USING ERRCODE = '42501'; END IF;
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
  ON CONFLICT ON CONSTRAINT client_consent_acceptances_pkey DO UPDATE
    SET accepted_at = client_consent_acceptances.accepted_at
  RETURNING * INTO _acceptance;
  document_id := _acceptance.document_id;
  accepted_at := _acceptance.accepted_at;
  RETURN NEXT;
END;
$$;

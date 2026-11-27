-- P06-A: authoritative registration admission, client eligibility and verified signup credits.
-- Existing users are not backfilled into the new eligibility policy.

INSERT INTO public.system_settings(key, value)
VALUES ('allow_new_registrations', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- The generic Admin settings policy must not bypass the reason + audit RPC for this gate.
DROP POLICY IF EXISTS "Admins manage settings" ON public.system_settings;
CREATE POLICY "Admins manage non-registration settings"
ON public.system_settings FOR ALL
USING (public.is_admin() AND key <> 'allow_new_registrations')
WITH CHECK (public.is_admin() AND key <> 'allow_new_registrations');

CREATE TABLE private.registration_admission_rate_limits (
  key_hash TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE private.registration_admissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  age_confirmed_at TIMESTAMPTZ NOT NULL,
  terms_accepted_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_user_id UUID
);
CREATE INDEX registration_admissions_email_created_idx
  ON private.registration_admissions(email_hash, created_at DESC);

CREATE TABLE private.registration_eligibility (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  admission_id UUID UNIQUE REFERENCES private.registration_admissions(id) ON DELETE SET NULL,
  policy_version TEXT NOT NULL CHECK (policy_version IN ('p06a-v1', 'p06a-admin-v1')),
  age_declared_at TIMESTAMPTZ,
  email_verified_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE private.signup_credit_grants (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id UUID UNIQUE REFERENCES public.credit_transactions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

REVOKE ALL ON TABLE private.registration_admission_rate_limits,
  private.registration_admissions,
  private.registration_eligibility,
  private.signup_credit_grants FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.registration_admission_open()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN jsonb_typeof(setting.value) = 'boolean' THEN (setting.value #>> '{}')::BOOLEAN
      ELSE FALSE
    END
    FROM public.system_settings setting
    WHERE setting.key = 'allow_new_registrations'
  ), FALSE);
$$;
REVOKE ALL ON FUNCTION private.registration_admission_open() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_registration_admission_for_server(
  _email TEXT,
  _age_confirmed BOOLEAN,
  _terms_accepted BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, private, extensions, pg_temp
AS $$
DECLARE
  _normalized_email TEXT := lower(btrim(COALESCE(_email, '')));
  _email_hash TEXT;
  _token TEXT;
  _token_hash TEXT;
  _now TIMESTAMPTZ := clock_timestamp();
  _attempts INTEGER;
  _expires TIMESTAMPTZ;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'server_boundary_required' USING ERRCODE = '42501';
  END IF;
  IF NOT private.registration_admission_open() THEN
    RETURN jsonb_build_object('allowed', FALSE, 'reason', 'registration_paused');
  END IF;
  IF NOT _age_confirmed OR NOT _terms_accepted
    OR _normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RETURN jsonb_build_object('allowed', FALSE, 'reason', 'eligibility_declaration_required');
  END IF;

  _email_hash := encode(extensions.digest(convert_to(_normalized_email, 'UTF8'), 'sha256'), 'hex');
  INSERT INTO private.registration_admission_rate_limits AS limiter(
    key_hash, window_started_at, attempts, updated_at
  ) VALUES (_email_hash, _now, 1, _now)
  ON CONFLICT (key_hash) DO UPDATE SET
    window_started_at = CASE
      WHEN limiter.window_started_at <= _now - interval '15 minutes' THEN _now
      ELSE limiter.window_started_at
    END,
    attempts = CASE
      WHEN limiter.window_started_at <= _now - interval '15 minutes' THEN 1
      ELSE limiter.attempts + 1
    END,
    updated_at = _now
  RETURNING attempts INTO _attempts;

  IF _attempts > 5 THEN
    RETURN jsonb_build_object('allowed', FALSE, 'reason', 'registration_rate_limited');
  END IF;

  _token := gen_random_uuid()::TEXT || gen_random_uuid()::TEXT;
  _token_hash := encode(extensions.digest(convert_to(_token, 'UTF8'), 'sha256'), 'hex');
  _expires := _now + interval '10 minutes';
  INSERT INTO private.registration_admissions(
    email_hash, token_hash, age_confirmed_at, terms_accepted_at, expires_at
  ) VALUES (_email_hash, _token_hash, _now, _now, _expires);

  RETURN jsonb_build_object(
    'allowed', TRUE,
    'admission_token', _token,
    'expires_at', _expires
  );
END;
$$;
REVOKE ALL ON FUNCTION public.create_registration_admission_for_server(TEXT, BOOLEAN, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_registration_admission_for_server(TEXT, BOOLEAN, BOOLEAN)
  TO service_role;

CREATE OR REPLACE FUNCTION public.before_user_created_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, private, extensions, pg_temp
AS $$
DECLARE
  _user JSONB := event -> 'user';
  _user_id UUID := NULLIF(_user ->> 'id', '')::UUID;
  _email TEXT := lower(btrim(COALESCE(_user ->> 'email', '')));
  _origin TEXT := COALESCE(_user -> 'app_metadata' ->> 'registration_origin', '');
  _token TEXT := COALESCE(_user -> 'user_metadata' ->> 'registration_admission_token', '');
  _email_hash TEXT;
  _token_hash TEXT;
  _admission_id UUID;
BEGIN
  -- app_metadata is writable only by the trusted Admin API; raw user metadata is never a role bypass.
  IF _origin = 'admin_provisioned' THEN
    RETURN '{}'::JSONB;
  END IF;
  IF NOT private.registration_admission_open() THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'registration_paused'
    ));
  END IF;
  IF _user_id IS NULL OR _email = '' OR _token = '' THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'registration_admission_required'
    ));
  END IF;

  _email_hash := encode(extensions.digest(convert_to(_email, 'UTF8'), 'sha256'), 'hex');
  _token_hash := encode(extensions.digest(convert_to(_token, 'UTF8'), 'sha256'), 'hex');
  UPDATE private.registration_admissions admission
  SET consumed_at = clock_timestamp(), consumed_user_id = _user_id
  WHERE admission.email_hash = _email_hash
    AND admission.token_hash = _token_hash
    AND admission.consumed_at IS NULL
    AND admission.expires_at > clock_timestamp()
  RETURNING admission.id INTO _admission_id;

  IF _admission_id IS NULL THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'registration_admission_invalid'
    ));
  END IF;
  RETURN '{}'::JSONB;
END;
$$;
REVOKE ALL ON FUNCTION public.before_user_created_hook(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.before_user_created_hook(JSONB) TO supabase_auth_admin;

CREATE OR REPLACE FUNCTION private.grant_signup_credits_for_user(_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _amount INTEGER;
  _balance INTEGER;
  _transaction_id UUID;
  _reserved BOOLEAN := FALSE;
BEGIN
  IF _user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = _user_id) THEN
    RAISE EXCEPTION 'unknown_registration_user';
  END IF;
  IF EXISTS (SELECT 1 FROM private.registration_eligibility WHERE user_id = _user_id)
    AND NOT EXISTS (
      SELECT 1 FROM private.registration_eligibility
      WHERE user_id = _user_id AND activated_at IS NOT NULL
    ) THEN
    RAISE EXCEPTION 'registration_not_eligible' USING ERRCODE = '42501';
  END IF;

  _amount := GREATEST(private.setting_int('free_credits_on_signup', 0), 0);
  INSERT INTO public.credit_wallets(user_id, balance, lifetime_earned, lifetime_spent)
  VALUES (_user_id, 0, 0, 0) ON CONFLICT (user_id) DO NOTHING;
  SELECT balance INTO _balance FROM public.credit_wallets WHERE user_id = _user_id FOR UPDATE;

  SELECT id INTO _transaction_id FROM public.credit_transactions
  WHERE user_id = _user_id AND type = 'signup_bonus' ORDER BY created_at LIMIT 1;
  IF _transaction_id IS NOT NULL THEN
    INSERT INTO private.signup_credit_grants(user_id, transaction_id)
    VALUES (_user_id, _transaction_id) ON CONFLICT (user_id) DO NOTHING;
    RETURN jsonb_build_object('granted', FALSE, 'amount', 0, 'balance', _balance, 'reason', 'already_granted');
  END IF;
  IF _amount <= 0 THEN
    RETURN jsonb_build_object('granted', FALSE, 'amount', 0, 'balance', _balance, 'reason', 'no_signup_credits_configured');
  END IF;

  INSERT INTO private.signup_credit_grants(user_id)
  VALUES (_user_id) ON CONFLICT (user_id) DO NOTHING RETURNING TRUE INTO _reserved;
  IF NOT COALESCE(_reserved, FALSE) THEN
    RETURN jsonb_build_object('granted', FALSE, 'amount', 0, 'balance', _balance, 'reason', 'already_granted');
  END IF;

  UPDATE public.credit_wallets SET
    balance = balance + _amount,
    lifetime_earned = lifetime_earned + _amount
  WHERE user_id = _user_id RETURNING balance INTO _balance;
  INSERT INTO public.credit_transactions(user_id, amount, balance_after, type, reason, metadata)
  VALUES (_user_id, _amount, _balance, 'signup_bonus', 'Signup free credits',
    jsonb_build_object('source', 'p06a_verified_eligibility'))
  RETURNING id INTO _transaction_id;
  UPDATE private.signup_credit_grants SET transaction_id = _transaction_id WHERE user_id = _user_id;
  RETURN jsonb_build_object('granted', TRUE, 'amount', _amount, 'balance', _balance, 'reason', 'signup_bonus');
END;
$$;
REVOKE ALL ON FUNCTION private.grant_signup_credits_for_user(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.activate_p06a_client_if_eligible(_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _eligibility private.registration_eligibility%ROWTYPE;
  _confirmed_at TIMESTAMPTZ;
  _credit JSONB;
BEGIN
  SELECT * INTO _eligibility FROM private.registration_eligibility
  WHERE user_id = _user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('activated', FALSE, 'reason', 'legacy_account'); END IF;
  IF _eligibility.activated_at IS NOT NULL THEN
    RETURN jsonb_build_object('activated', TRUE, 'reason', 'already_active');
  END IF;
  IF _eligibility.policy_version = 'p06a-v1' AND _eligibility.age_declared_at IS NULL THEN
    RETURN jsonb_build_object('activated', FALSE, 'reason', 'age_declaration_required');
  END IF;
  SELECT email_confirmed_at INTO _confirmed_at FROM auth.users WHERE id = _user_id;
  IF _confirmed_at IS NULL THEN RETURN jsonb_build_object('activated', FALSE, 'reason', 'email_verification_required'); END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.client_profiles profile
    WHERE profile.user_id = _user_id
      AND profile.onboarding_completed_at IS NOT NULL
      AND COALESCE(profile.computed_age, profile.age) BETWEEN 18 AND 120
  ) THEN
    RETURN jsonb_build_object('activated', FALSE, 'reason', 'eligible_profile_required');
  END IF;
  UPDATE private.registration_eligibility SET
    email_verified_at = _confirmed_at,
    activated_at = clock_timestamp(),
    updated_at = clock_timestamp()
  WHERE user_id = _user_id;
  _credit := private.grant_signup_credits_for_user(_user_id);
  RETURN jsonb_build_object('activated', TRUE, 'reason', 'eligible', 'credit', _credit);
END;
$$;
REVOKE ALL ON FUNCTION private.activate_p06a_client_if_eligible(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.p06a_auth_confirmation_trigger()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$ BEGIN
  IF NEW.email_confirmed_at IS NOT NULL AND OLD.email_confirmed_at IS DISTINCT FROM NEW.email_confirmed_at THEN
    PERFORM private.activate_p06a_client_if_eligible(NEW.id);
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS p06a_auth_confirmation ON auth.users;
CREATE TRIGGER p06a_auth_confirmation AFTER UPDATE OF email_confirmed_at ON auth.users
FOR EACH ROW EXECUTE FUNCTION private.p06a_auth_confirmation_trigger();

CREATE OR REPLACE FUNCTION private.p06a_profile_eligibility_trigger()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$ BEGIN
  PERFORM private.activate_p06a_client_if_eligible(NEW.user_id);
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS p06a_profile_eligibility ON public.client_profiles;
CREATE TRIGGER p06a_profile_eligibility
AFTER INSERT OR UPDATE OF onboarding_completed_at, computed_age, age ON public.client_profiles
FOR EACH ROW EXECUTE FUNCTION private.p06a_profile_eligibility_trigger();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _admission private.registration_admissions%ROWTYPE;
  _admin_provisioned BOOLEAN := COALESCE(NEW.raw_app_meta_data ->> 'registration_origin', '') = 'admin_provisioned';
BEGIN
  INSERT INTO public.profiles(user_id, email, display_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data ->> 'display_name', split_part(NEW.email, '@', 1)))
  ON CONFLICT (user_id) DO NOTHING;
  INSERT INTO public.user_roles(user_id, role) VALUES (NEW.id, 'client')
  ON CONFLICT (user_id, role) DO NOTHING;
  INSERT INTO public.client_profiles(user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO _admission FROM private.registration_admissions
  WHERE consumed_user_id = NEW.id ORDER BY consumed_at DESC LIMIT 1;
  IF FOUND THEN
    INSERT INTO private.registration_eligibility(user_id, admission_id, policy_version, age_declared_at)
    VALUES (NEW.id, _admission.id, 'p06a-v1', _admission.age_confirmed_at)
    ON CONFLICT (user_id) DO NOTHING;
  ELSIF _admin_provisioned THEN
    INSERT INTO private.registration_eligibility(user_id, policy_version)
    VALUES (NEW.id, 'p06a-admin-v1') ON CONFLICT (user_id) DO NOTHING;
  END IF;
  PERFORM private.activate_p06a_client_if_eligible(NEW.id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.ensure_active_client(_user_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _mandatory_onboarding BOOLEAN := FALSE;
  _consent_policy_enabled BOOLEAN := FALSE;
BEGIN
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
  IF _consent_policy_enabled AND NOT private.has_required_client_consents(_user_id) THEN
    RAISE EXCEPTION 'client_consent_required' USING ERRCODE = '42501';
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
REVOKE ALL ON FUNCTION private.ensure_active_client(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.ensure_active_client(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_set_registration_state(_allow BOOLEAN, _reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE _admin UUID := auth.uid(); _reason_clean TEXT := btrim(COALESCE(_reason, ''));
BEGIN
  IF _admin IS NULL OR NOT public.has_role(_admin, 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
  END IF;
  IF _reason_clean = '' OR char_length(_reason_clean) > 500 THEN
    RAISE EXCEPTION 'registration_reason_required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.system_settings(key, value) VALUES ('allow_new_registrations', to_jsonb(_allow))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();
  INSERT INTO public.audit_logs(actor_user_id, action, entity_type, entity_id, metadata)
  VALUES (_admin, 'registration.admission.changed', 'system_setting', 'allow_new_registrations',
    jsonb_build_object('allow', _allow, 'reason', _reason_clean));
  RETURN jsonb_build_object('allow_new_registrations', _allow);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_registration_state(BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_registration_state(BOOLEAN, TEXT) TO authenticated;

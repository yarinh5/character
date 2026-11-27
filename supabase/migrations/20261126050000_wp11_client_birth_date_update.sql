-- A DOB-only edit must not rewrite onboarding preferences, images or display name.
CREATE OR REPLACE FUNCTION public.update_client_birth_date(_date_of_birth DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _user_id UUID := auth.uid();
  _age INTEGER;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  PERFORM private.ensure_recovery_business_open();
  IF private.account_deletion_blocks_business_activity(_user_id) OR NOT EXISTS (
    SELECT 1 FROM public.user_roles role
    JOIN public.profiles profile ON profile.user_id = role.user_id
    WHERE role.user_id = _user_id
      AND role.role = 'client'::public.app_role
      AND COALESCE(profile.status, 'active') = 'active'
      AND profile.deleted_at IS NULL
      AND profile.pii_archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'client_account_inactive' USING ERRCODE = '42501';
  END IF;
  IF _date_of_birth IS NULL THEN
    RAISE EXCEPTION 'invalid_birth_date' USING ERRCODE = '22023';
  END IF;
  _age := EXTRACT(YEAR FROM age(CURRENT_DATE, _date_of_birth))::INTEGER;
  IF _age NOT BETWEEN 18 AND 120 THEN
    RAISE EXCEPTION 'invalid_onboarding_age' USING ERRCODE = '22023';
  END IF;

  UPDATE public.client_profiles
  SET date_of_birth = _date_of_birth,
      computed_age = _age,
      age = _age
  WHERE user_id = _user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'client_profile_required' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('date_of_birth', _date_of_birth, 'computed_age', _age);
END;
$$;

REVOKE ALL ON FUNCTION public.update_client_birth_date(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_client_birth_date(DATE) TO authenticated;

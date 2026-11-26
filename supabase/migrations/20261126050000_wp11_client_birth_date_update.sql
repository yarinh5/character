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
  PERFORM private.ensure_active_client(_user_id);
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

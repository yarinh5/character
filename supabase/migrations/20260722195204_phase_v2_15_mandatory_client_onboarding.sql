-- V2-15: mandatory onboarding remains off until explicitly enabled by Admin.
INSERT INTO public.system_settings (key, value)
VALUES ('mandatory_onboarding_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION private.apply_client_onboarding_payload(
  _payload JSONB,
  _complete BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client_id UUID := (SELECT auth.uid());
  _current public.client_profiles%ROWTYPE;
  _first_name TEXT;
  _last_name TEXT;
  _bio TEXT;
  _relationship_status TEXT;
  _smoking_status TEXT;
  _profile_image_url TEXT;
  _profile_image_urls TEXT[];
  _city_id UUID;
  _date_of_birth DATE;
  _computed_age INTEGER;
  _preferred_min_age INTEGER;
  _preferred_max_age INTEGER;
  _preferred_distance_km INTEGER;
  _content_preferences JSONB;
  _character_preferences JSONB;
  _onboarding_step INTEGER;
  _completed_at TIMESTAMPTZ;
BEGIN
  IF _client_id IS NULL
    OR NOT public.has_role(_client_id, 'client'::public.app_role) THEN
    RAISE EXCEPTION 'client_profile_required' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(_payload) <> 'object' THEN
    RAISE EXCEPTION 'invalid_onboarding_payload';
  END IF;

  SELECT *
  INTO _current
  FROM public.client_profiles
  WHERE user_id = _client_id
  FOR UPDATE;

  _first_name := COALESCE(NULLIF(btrim(_payload ->> 'first_name'), ''), _current.first_name);
  _last_name := COALESCE(NULLIF(btrim(_payload ->> 'last_name'), ''), _current.last_name);
  _bio := COALESCE(NULLIF(btrim(_payload ->> 'bio'), ''), _current.bio);
  _relationship_status := COALESCE(NULLIF(btrim(_payload ->> 'relationship_status'), ''), _current.relationship_status);
  _smoking_status := COALESCE(NULLIF(btrim(_payload ->> 'smoking_status'), ''), _current.smoking_status);
  _profile_image_url := COALESCE(NULLIF(btrim(_payload ->> 'profile_image_url'), ''), _current.profile_image_url);

  IF _first_name IS NOT NULL AND char_length(_first_name) > 80 THEN
    RAISE EXCEPTION 'invalid_first_name';
  END IF;
  IF _last_name IS NOT NULL AND char_length(_last_name) > 80 THEN
    RAISE EXCEPTION 'invalid_last_name';
  END IF;
  IF _bio IS NOT NULL AND char_length(_bio) > 1000 THEN
    RAISE EXCEPTION 'invalid_bio';
  END IF;
  IF _relationship_status IS NOT NULL
    AND _relationship_status NOT IN ('single', 'in_relationship', 'married', 'prefer_not_to_say') THEN
    RAISE EXCEPTION 'invalid_relationship_status';
  END IF;
  IF _smoking_status IS NOT NULL
    AND _smoking_status NOT IN ('never', 'sometimes', 'regularly', 'prefer_not_to_say') THEN
    RAISE EXCEPTION 'invalid_smoking_status';
  END IF;

  IF _payload ? 'city_id' AND NULLIF(btrim(_payload ->> 'city_id'), '') IS NOT NULL THEN
    _city_id := (_payload ->> 'city_id')::UUID;
  ELSE
    _city_id := _current.city_id;
  END IF;

  IF _city_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.discovery_cities city
    WHERE city.id = _city_id
      AND city.is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'invalid_onboarding_city';
  END IF;

  IF _payload ? 'date_of_birth' AND NULLIF(btrim(_payload ->> 'date_of_birth'), '') IS NOT NULL THEN
    _date_of_birth := (_payload ->> 'date_of_birth')::DATE;
  ELSE
    _date_of_birth := _current.date_of_birth;
  END IF;

  _computed_age := COALESCE(_current.computed_age, _current.age);
  IF _date_of_birth IS NOT NULL THEN
    _computed_age := EXTRACT(YEAR FROM age(CURRENT_DATE, _date_of_birth))::INTEGER;
  END IF;
  IF _computed_age IS NOT NULL AND _computed_age NOT BETWEEN 18 AND 120 THEN
    RAISE EXCEPTION 'invalid_onboarding_age';
  END IF;

  IF _payload ? 'preferred_min_age' THEN
    _preferred_min_age := NULLIF(_payload ->> 'preferred_min_age', '')::INTEGER;
  ELSE
    _preferred_min_age := _current.preferred_min_age;
  END IF;
  IF _payload ? 'preferred_max_age' THEN
    _preferred_max_age := NULLIF(_payload ->> 'preferred_max_age', '')::INTEGER;
  ELSE
    _preferred_max_age := _current.preferred_max_age;
  END IF;
  IF _payload ? 'preferred_distance_km' THEN
    _preferred_distance_km := NULLIF(_payload ->> 'preferred_distance_km', '')::INTEGER;
  ELSE
    _preferred_distance_km := _current.preferred_distance_km;
  END IF;

  IF (_preferred_min_age IS NOT NULL AND _preferred_min_age NOT BETWEEN 18 AND 120)
    OR (_preferred_max_age IS NOT NULL AND _preferred_max_age NOT BETWEEN 18 AND 120)
    OR (_preferred_min_age IS NOT NULL AND _preferred_max_age IS NOT NULL AND _preferred_min_age > _preferred_max_age)
    OR (_preferred_distance_km IS NOT NULL AND _preferred_distance_km <= 0) THEN
    RAISE EXCEPTION 'invalid_onboarding_preferences';
  END IF;

  IF _payload ? 'content_preferences' THEN
    _content_preferences := _payload -> 'content_preferences';
  ELSE
    _content_preferences := COALESCE(_current.content_preferences, '[]'::JSONB);
  END IF;
  IF _payload ? 'character_preferences' THEN
    _character_preferences := _payload -> 'character_preferences';
  ELSE
    _character_preferences := COALESCE(_current.character_preferences, '[]'::JSONB);
  END IF;

  IF jsonb_typeof(_content_preferences) <> 'array'
    OR jsonb_typeof(_character_preferences) <> 'array'
    OR jsonb_array_length(_content_preferences) > 20
    OR jsonb_array_length(_character_preferences) > 20
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(_content_preferences || _character_preferences) value
      WHERE jsonb_typeof(value) <> 'string'
        OR char_length(btrim(value #>> '{}')) NOT BETWEEN 1 AND 80
    ) THEN
    RAISE EXCEPTION 'invalid_onboarding_preferences';
  END IF;

  IF _payload ? 'profile_image_urls' THEN
    IF jsonb_typeof(_payload -> 'profile_image_urls') <> 'array' THEN
      RAISE EXCEPTION 'invalid_profile_image_urls';
    END IF;
    SELECT COALESCE(array_agg(value #>> '{}'), '{}'::TEXT[])
    INTO _profile_image_urls
    FROM jsonb_array_elements(_payload -> 'profile_image_urls') value;
  ELSIF _profile_image_url IS NOT NULL THEN
    _profile_image_urls := ARRAY[_profile_image_url];
  ELSE
    _profile_image_urls := COALESCE(_current.profile_image_urls, '{}'::TEXT[]);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(_profile_image_urls) AS url
    WHERE NULLIF(btrim(url), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'invalid_profile_image_urls';
  END IF;

  IF _payload ? 'onboarding_step' THEN
    IF jsonb_typeof(_payload -> 'onboarding_step') <> 'number'
      OR (_payload ->> 'onboarding_step') !~ '^\\d$' THEN
      RAISE EXCEPTION 'invalid_onboarding_step';
    END IF;
    _onboarding_step := (_payload ->> 'onboarding_step')::INTEGER;
  ELSE
    _onboarding_step := COALESCE(_current.onboarding_step, 0);
  END IF;
  IF _onboarding_step NOT BETWEEN 0 AND 3 THEN
    RAISE EXCEPTION 'invalid_onboarding_step';
  END IF;

  IF _complete AND (
    _first_name IS NULL
    OR _last_name IS NULL
    OR _computed_age IS NULL
    OR _city_id IS NULL
    OR _bio IS NULL
    OR char_length(_bio) < 10
    OR _relationship_status IS NULL
    OR _smoking_status IS NULL
    OR _preferred_min_age IS NULL
    OR _preferred_max_age IS NULL
    OR _preferred_distance_km IS NULL
    OR jsonb_array_length(_content_preferences) = 0
    OR jsonb_array_length(_character_preferences) = 0
  ) THEN
    RAISE EXCEPTION 'onboarding_incomplete';
  END IF;

  _completed_at := CASE
    WHEN _complete THEN COALESCE(_current.onboarding_completed_at, clock_timestamp())
    ELSE _current.onboarding_completed_at
  END;

  INSERT INTO public.client_profiles (
    user_id,
    first_name,
    last_name,
    date_of_birth,
    computed_age,
    city_id,
    bio,
    relationship_status,
    smoking_status,
    preferred_min_age,
    preferred_max_age,
    preferred_distance_km,
    content_preferences,
    character_preferences,
    onboarding_step,
    onboarding_completed_at,
    profile_image_url,
    profile_image_urls,
    age,
    interests
  )
  VALUES (
    _client_id,
    _first_name,
    _last_name,
    _date_of_birth,
    _computed_age,
    _city_id,
    _bio,
    _relationship_status,
    _smoking_status,
    _preferred_min_age,
    _preferred_max_age,
    _preferred_distance_km,
    _content_preferences,
    _character_preferences,
    _onboarding_step,
    _completed_at,
    _profile_image_url,
    _profile_image_urls,
    _computed_age,
    ARRAY(SELECT jsonb_array_elements_text(_content_preferences))
  )
  ON CONFLICT (user_id) DO UPDATE
  SET
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name,
    date_of_birth = EXCLUDED.date_of_birth,
    computed_age = EXCLUDED.computed_age,
    city_id = EXCLUDED.city_id,
    bio = EXCLUDED.bio,
    relationship_status = EXCLUDED.relationship_status,
    smoking_status = EXCLUDED.smoking_status,
    preferred_min_age = EXCLUDED.preferred_min_age,
    preferred_max_age = EXCLUDED.preferred_max_age,
    preferred_distance_km = EXCLUDED.preferred_distance_km,
    content_preferences = EXCLUDED.content_preferences,
    character_preferences = EXCLUDED.character_preferences,
    onboarding_step = GREATEST(client_profiles.onboarding_step, EXCLUDED.onboarding_step),
    onboarding_completed_at = EXCLUDED.onboarding_completed_at,
    profile_image_url = EXCLUDED.profile_image_url,
    profile_image_urls = EXCLUDED.profile_image_urls,
    age = EXCLUDED.age,
    interests = EXCLUDED.interests;

  UPDATE public.profiles
  SET
    display_name = concat_ws(' ', _first_name, _last_name),
    avatar_url = COALESCE(_profile_image_url, avatar_url)
  WHERE user_id = _client_id;

  RETURN jsonb_build_object(
    'onboarding_step', GREATEST(COALESCE(_current.onboarding_step, 0), _onboarding_step),
    'onboarding_completed_at', _completed_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_client_onboarding_step(_payload JSONB)
RETURNS JSONB
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT private.apply_client_onboarding_payload(_payload, FALSE);
$$;

CREATE OR REPLACE FUNCTION public.complete_client_onboarding(_payload JSONB)
RETURNS JSONB
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT private.apply_client_onboarding_payload(_payload, TRUE);
$$;

REVOKE ALL ON FUNCTION private.apply_client_onboarding_payload(JSONB, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_client_onboarding_step(JSONB)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_client_onboarding(JSONB)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_client_onboarding_step(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_client_onboarding(JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';

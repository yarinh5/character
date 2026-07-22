-- V2-14: additive client profile/onboarding foundation. No onboarding guard is
-- enabled here, so legacy clients remain usable while later UI is introduced.

ALTER TABLE public.client_profiles
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name TEXT,
  ADD COLUMN IF NOT EXISTS date_of_birth DATE,
  ADD COLUMN IF NOT EXISTS computed_age INTEGER,
  ADD COLUMN IF NOT EXISTS city_id UUID REFERENCES public.discovery_cities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bio TEXT,
  ADD COLUMN IF NOT EXISTS relationship_status TEXT,
  ADD COLUMN IF NOT EXISTS smoking_status TEXT,
  ADD COLUMN IF NOT EXISTS preferred_min_age INTEGER,
  ADD COLUMN IF NOT EXISTS preferred_max_age INTEGER,
  ADD COLUMN IF NOT EXISTS preferred_distance_km INTEGER,
  ADD COLUMN IF NOT EXISTS content_preferences JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS character_preferences JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS onboarding_step INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS profile_image_url TEXT,
  ADD COLUMN IF NOT EXISTS profile_image_urls TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

ALTER TABLE public.discovery_cities
  ADD COLUMN IF NOT EXISTS latitude NUMERIC(9, 6),
  ADD COLUMN IF NOT EXISTS longitude NUMERIC(9, 6);

CREATE OR REPLACE FUNCTION private.is_valid_profile_image_urls(_urls TEXT[])
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT _urls IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(_urls) AS url
      WHERE NULLIF(btrim(url), '') IS NULL
    );
$$;

REVOKE ALL ON FUNCTION private.is_valid_profile_image_urls(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_valid_profile_image_urls(TEXT[]) TO authenticated, service_role;

ALTER TABLE public.client_profiles
  DROP CONSTRAINT IF EXISTS client_profiles_computed_age_check,
  ADD CONSTRAINT client_profiles_computed_age_check
    CHECK (computed_age IS NULL OR computed_age BETWEEN 18 AND 120),
  DROP CONSTRAINT IF EXISTS client_profiles_preferred_age_range_check,
  ADD CONSTRAINT client_profiles_preferred_age_range_check
    CHECK (
      (preferred_min_age IS NULL OR preferred_min_age BETWEEN 18 AND 120)
      AND (preferred_max_age IS NULL OR preferred_max_age BETWEEN 18 AND 120)
      AND (preferred_min_age IS NULL OR preferred_max_age IS NULL OR preferred_min_age <= preferred_max_age)
    ),
  DROP CONSTRAINT IF EXISTS client_profiles_preferred_distance_check,
  ADD CONSTRAINT client_profiles_preferred_distance_check
    CHECK (preferred_distance_km IS NULL OR preferred_distance_km > 0),
  DROP CONSTRAINT IF EXISTS client_profiles_content_preferences_check,
  ADD CONSTRAINT client_profiles_content_preferences_check
    CHECK (jsonb_typeof(content_preferences) = 'array'),
  DROP CONSTRAINT IF EXISTS client_profiles_character_preferences_check,
  ADD CONSTRAINT client_profiles_character_preferences_check
    CHECK (jsonb_typeof(character_preferences) = 'array'),
  DROP CONSTRAINT IF EXISTS client_profiles_onboarding_step_check,
  ADD CONSTRAINT client_profiles_onboarding_step_check
    CHECK (onboarding_step >= 0),
  DROP CONSTRAINT IF EXISTS client_profiles_profile_image_url_check,
  ADD CONSTRAINT client_profiles_profile_image_url_check
    CHECK (profile_image_url IS NULL OR NULLIF(btrim(profile_image_url), '') IS NOT NULL),
  DROP CONSTRAINT IF EXISTS client_profiles_profile_image_urls_check,
  ADD CONSTRAINT client_profiles_profile_image_urls_check
    CHECK (private.is_valid_profile_image_urls(profile_image_urls));

ALTER TABLE public.discovery_cities
  DROP CONSTRAINT IF EXISTS discovery_cities_latitude_check,
  ADD CONSTRAINT discovery_cities_latitude_check
    CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  DROP CONSTRAINT IF EXISTS discovery_cities_longitude_check,
  ADD CONSTRAINT discovery_cities_longitude_check
    CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);

CREATE INDEX IF NOT EXISTS client_profiles_city_id_idx
  ON public.client_profiles(city_id)
  WHERE city_id IS NOT NULL;

-- Best-effort legacy backfill. Invalid legacy ages remain NULL rather than
-- violating the new validation boundary, and no onboarding flow is enabled.
UPDATE public.client_profiles cp
SET
  first_name = COALESCE(
    cp.first_name,
    NULLIF(split_part(btrim(p.display_name), ' ', 1), '')
  ),
  last_name = COALESCE(
    cp.last_name,
    NULLIF(btrim(regexp_replace(btrim(p.display_name), '^[^[:space:]]+[[:space:]]*', '')), '')
  ),
  computed_age = CASE
    WHEN cp.date_of_birth IS NULL AND cp.computed_age IS NULL AND cp.age BETWEEN 18 AND 120 THEN cp.age
    ELSE cp.computed_age
  END,
  profile_image_url = COALESCE(cp.profile_image_url, NULLIF(btrim(p.avatar_url), '')),
  profile_image_urls = CASE
    WHEN cardinality(cp.profile_image_urls) = 0 AND NULLIF(btrim(p.avatar_url), '') IS NOT NULL
      THEN ARRAY[NULLIF(btrim(p.avatar_url), '')]
    ELSE cp.profile_image_urls
  END,
  onboarding_completed_at = CASE
    WHEN cp.onboarding_completed_at IS NULL
      AND cp.age BETWEEN 18 AND 120
      AND NULLIF(btrim(cp.gender), '') IS NOT NULL
      AND COALESCE(cardinality(cp.interests), 0) > 0
      THEN clock_timestamp()
    ELSE cp.onboarding_completed_at
  END
FROM public.profiles p
WHERE p.user_id = cp.user_id;

-- Tighten the profile boundary without changing the legacy operator queries:
-- clients retain ownership-only access, admins can manage profiles, and anon has
-- no table privilege. Operator UI continues to request legacy fields explicitly.
REVOKE ALL ON TABLE public.client_profiles FROM anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.client_profiles TO authenticated;

DROP POLICY IF EXISTS "Clients view own client_profile" ON public.client_profiles;
CREATE POLICY "Clients view own client_profile"
  ON public.client_profiles
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Clients update own client_profile" ON public.client_profiles;
CREATE POLICY "Clients update own client_profile"
  ON public.client_profiles
  FOR UPDATE
  TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Clients insert own client_profile" ON public.client_profiles;
CREATE POLICY "Clients insert own client_profile"
  ON public.client_profiles
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Admins view all client_profiles" ON public.client_profiles;
CREATE POLICY "Admins view all client_profiles"
  ON public.client_profiles
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "Admins update all client_profiles" ON public.client_profiles;
CREATE POLICY "Admins update all client_profiles"
  ON public.client_profiles
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

NOTIFY pgrst, 'reload schema';

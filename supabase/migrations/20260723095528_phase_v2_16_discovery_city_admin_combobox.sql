-- The earlier QA seed wrote mojibake labels. Keep the rows for audit/history,
-- but remove them from all client and Admin selectors.
UPDATE public.discovery_cities
SET is_active = FALSE
WHERE slug IN ('tel-aviv', 'jerusalem', 'haifa', 'beer-sheva');

CREATE OR REPLACE FUNCTION public.create_discovery_city(
  _display_name_he TEXT
)
RETURNS TABLE (
  id UUID,
  display_name_he TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _name TEXT;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_required';
  END IF;

  _name := regexp_replace(btrim(COALESCE(_display_name_he, '')), '\s+', ' ', 'g');

  IF char_length(_name) = 0 OR char_length(_name) > 120 THEN
    RAISE EXCEPTION 'invalid_discovery_city_name';
  END IF;

  -- Serializes same-name requests without imposing a language-specific slug.
  PERFORM pg_advisory_xact_lock(hashtextextended(lower(_name), 0));

  RETURN QUERY
  UPDATE public.discovery_cities AS city
  SET is_active = TRUE
  WHERE lower(btrim(city.display_name_he)) = lower(_name)
  RETURNING city.id, city.display_name_he;

  IF FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO public.discovery_cities (slug, display_name_he, is_active)
  VALUES (
    'city-' || left(replace(gen_random_uuid()::TEXT, '-', ''), 16),
    _name,
    TRUE
  )
  RETURNING discovery_cities.id, discovery_cities.display_name_he;
END;
$$;

REVOKE ALL ON FUNCTION public.create_discovery_city(TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_discovery_city(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

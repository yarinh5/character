CREATE OR REPLACE FUNCTION private.normalize_discovery_filters(_filters JSONB)
RETURNS TABLE (
  filter_hash TEXT,
  min_age INTEGER,
  max_age INTEGER,
  city_id UUID
)
LANGUAGE plpgsql
SET search_path = public, private
AS $$
DECLARE
  _input JSONB := COALESCE(_filters, '{}'::JSONB);
  _raw_min_age TEXT;
  _raw_max_age TEXT;
  _raw_city_id TEXT;
  _raw_interest TEXT;
  _favorites_only BOOLEAN := FALSE;
  _recycled_only BOOLEAN := FALSE;
  _interest TEXT;
  _canonical JSONB;
BEGIN
  IF jsonb_typeof(_input) <> 'object' THEN
    RAISE EXCEPTION 'invalid_discovery_filters';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(_input) AS key_name(key)
    WHERE key NOT IN (
      'min_age',
      'max_age',
      'city_id',
      'favorites_only',
      'recycled_only',
      'interest'
    )
  ) THEN
    RAISE EXCEPTION 'unsupported_discovery_filter';
  END IF;

  _raw_min_age := _input ->> 'min_age';
  _raw_max_age := _input ->> 'max_age';
  _raw_city_id := _input ->> 'city_id';
  _raw_interest := _input ->> 'interest';

  IF _raw_min_age IS NOT NULL THEN
    IF jsonb_typeof(_input -> 'min_age') <> 'number'
      OR _raw_min_age !~ '^[0-9]{1,3}$' THEN
      RAISE EXCEPTION 'invalid_discovery_min_age';
    END IF;

    min_age := _raw_min_age::INTEGER;
    IF min_age < 18 OR min_age > 120 THEN
      RAISE EXCEPTION 'discovery_min_age_out_of_range';
    END IF;
  END IF;

  IF _raw_max_age IS NOT NULL THEN
    IF jsonb_typeof(_input -> 'max_age') <> 'number'
      OR _raw_max_age !~ '^[0-9]{1,3}$' THEN
      RAISE EXCEPTION 'invalid_discovery_max_age';
    END IF;

    max_age := _raw_max_age::INTEGER;
    IF max_age < 18 OR max_age > 120 THEN
      RAISE EXCEPTION 'discovery_max_age_out_of_range';
    END IF;
  END IF;

  IF min_age IS NOT NULL AND max_age IS NOT NULL AND min_age > max_age THEN
    RAISE EXCEPTION 'invalid_discovery_age_range';
  END IF;

  IF _raw_city_id IS NOT NULL THEN
    _raw_city_id := lower(_raw_city_id);
    IF jsonb_typeof(_input -> 'city_id') <> 'string'
      OR _raw_city_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid_discovery_city';
    END IF;

    city_id := _raw_city_id::UUID;
    PERFORM 1
    FROM public.discovery_cities c
    WHERE c.id = city_id
      AND c.is_active = TRUE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_discovery_city';
    END IF;
  END IF;

  IF _input ? 'favorites_only' THEN
    IF jsonb_typeof(_input -> 'favorites_only') <> 'boolean' THEN
      RAISE EXCEPTION 'invalid_discovery_favorites_only';
    END IF;
    _favorites_only := (_input ->> 'favorites_only')::BOOLEAN;
  END IF;

  IF _input ? 'recycled_only' THEN
    IF jsonb_typeof(_input -> 'recycled_only') <> 'boolean' THEN
      RAISE EXCEPTION 'invalid_discovery_recycled_only';
    END IF;
    _recycled_only := (_input ->> 'recycled_only')::BOOLEAN;
  END IF;

  IF _raw_interest IS NOT NULL THEN
    IF jsonb_typeof(_input -> 'interest') <> 'string' THEN
      RAISE EXCEPTION 'invalid_discovery_interest';
    END IF;
    _interest := lower(btrim(_raw_interest));
    IF _interest = '' OR char_length(_interest) > 80 THEN
      RAISE EXCEPTION 'invalid_discovery_interest';
    END IF;
  END IF;

  _canonical := jsonb_build_object(
    'v', 3,
    'min_age', min_age,
    'max_age', max_age,
    'city_id', city_id,
    'favorites_only', _favorites_only,
    'recycled_only', _recycled_only,
    'interest', _interest
  );

  filter_hash := 'v3:' || md5(_canonical::TEXT);
  RETURN NEXT;
END;
$$;

NOTIFY pgrst, 'reload schema';

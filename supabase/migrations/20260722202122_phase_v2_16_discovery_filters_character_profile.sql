-- Keep the established discovery cycle and swipe mechanics intact. The public
-- wrapper below adds UI filters while the original function remains internal.
ALTER FUNCTION public.get_discovery_characters(JSONB)
  RENAME TO get_discovery_characters_base;

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
      OR _raw_min_age !~ '^\\d{1,3}$' THEN
      RAISE EXCEPTION 'invalid_discovery_min_age';
    END IF;

    min_age := _raw_min_age::INTEGER;
    IF min_age < 18 OR min_age > 120 THEN
      RAISE EXCEPTION 'discovery_min_age_out_of_range';
    END IF;
  END IF;

  IF _raw_max_age IS NOT NULL THEN
    IF jsonb_typeof(_input -> 'max_age') <> 'number'
      OR _raw_max_age !~ '^\\d{1,3}$' THEN
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

CREATE FUNCTION public.get_discovery_characters(
  _filters JSONB DEFAULT '{}'::JSONB
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  avatar_url TEXT,
  fictional_age INTEGER,
  short_description TEXT,
  category TEXT,
  interests TEXT[],
  availability_status public.availability_status,
  created_at TIMESTAMPTZ,
  cycle_id UUID,
  cycle_number INTEGER,
  is_liked BOOLEAN,
  is_favorite BOOLEAN,
  conversation_id UUID,
  is_recycled BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _client UUID := auth.uid();
  _favorites_only BOOLEAN;
  _recycled_only BOOLEAN;
  _interest TEXT;
  _selected_cycle_id UUID;
  _selected_character_id UUID;
BEGIN
  IF _client IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM private.ensure_active_client(_client);
  PERFORM 1 FROM private.normalize_discovery_filters(_filters);

  _favorites_only := COALESCE((_filters ->> 'favorites_only')::BOOLEAN, FALSE);
  _recycled_only := COALESCE((_filters ->> 'recycled_only')::BOOLEAN, FALSE);
  _interest := NULLIF(lower(btrim(_filters ->> 'interest')), '');

  IF NOT EXISTS (
    SELECT 1
    FROM public.characters c
    LEFT JOIN public.client_character_preferences p
      ON p.client_id = _client
     AND p.character_id = c.id
    WHERE c.is_active = TRUE
      AND c.is_visible = TRUE
      AND (NOT _favorites_only OR p.is_favorite IS TRUE)
      AND (NOT _recycled_only OR COALESCE(p.shown_count, 0) > 0)
      AND (_interest IS NULL OR EXISTS (
        SELECT 1
        FROM unnest(COALESCE(c.interests, ARRAY[]::TEXT[])) AS interest_name(value)
        WHERE lower(interest_name.value) = _interest
      ))
  ) THEN
    RETURN;
  END IF;

  LOOP
    SELECT b.*
    INTO id, name, avatar_url, fictional_age, short_description, category,
      interests, availability_status, created_at, cycle_id, cycle_number,
      is_liked, is_favorite, conversation_id, is_recycled
    FROM public.get_discovery_characters_base(_filters) b
    LIMIT 1;

    IF NOT FOUND THEN
      RETURN;
    END IF;

    IF (NOT _favorites_only OR is_favorite)
      AND (NOT _recycled_only OR is_recycled)
      AND (_interest IS NULL OR EXISTS (
        SELECT 1
        FROM unnest(COALESCE(interests, ARRAY[]::TEXT[])) AS interest_name(value)
        WHERE lower(interest_name.value) = _interest
      )) THEN
      RETURN NEXT;
      RETURN;
    END IF;

    _selected_cycle_id := cycle_id;
    _selected_character_id := id;

    UPDATE public.client_discovery_cycle_items
    SET action = 'expired',
        acted_at = now()
    WHERE public.client_discovery_cycle_items.cycle_id = _selected_cycle_id
      AND public.client_discovery_cycle_items.character_id = _selected_character_id
      AND action IS NULL;
  END LOOP;
END;
$$;

CREATE FUNCTION public.get_character_profile(_character_id UUID)
RETURNS TABLE (
  id UUID,
  name TEXT,
  avatar_url TEXT,
  fictional_age INTEGER,
  short_description TEXT,
  full_description TEXT,
  personality TEXT,
  category TEXT,
  interests TEXT[],
  availability_status public.availability_status,
  city_name TEXT,
  gallery_images TEXT[],
  is_favorite BOOLEAN,
  conversation_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _client UUID := auth.uid();
BEGIN
  IF _client IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM private.ensure_active_client(_client);

  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c.avatar_url,
    c.fictional_age,
    c.short_description,
    c.full_description,
    c.personality,
    c.category,
    c.interests,
    c.availability_status,
    city.display_name_he,
    c.gallery_images,
    COALESCE(preference.is_favorite, FALSE),
    conversation.id
  FROM public.characters c
  LEFT JOIN public.discovery_cities city
    ON city.id = c.discovery_city_id
   AND city.is_active = TRUE
  LEFT JOIN public.client_character_preferences preference
    ON preference.client_id = _client
   AND preference.character_id = c.id
  LEFT JOIN LATERAL (
    SELECT active_conversation.id
    FROM public.conversations active_conversation
    WHERE active_conversation.client_id = _client
      AND active_conversation.character_id = c.id
      AND active_conversation.status <> 'closed'::public.conversation_status
      AND active_conversation.client_hidden_at IS NULL
    ORDER BY active_conversation.updated_at DESC
    LIMIT 1
  ) conversation ON TRUE
  WHERE c.id = _character_id
    AND c.is_active = TRUE
    AND c.is_visible = TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_characters_base(JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_discovery_characters(JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_character_profile(UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_discovery_characters(JSONB)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_character_profile(UUID)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

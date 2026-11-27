CREATE OR REPLACE FUNCTION public.get_discovery_characters(
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
SET search_path = public, private, pg_temp
AS $$
DECLARE
  _client UUID := auth.uid();
  _favorites_only BOOLEAN;
  _recycled_only BOOLEAN;
  _interest TEXT;
  _max_distance INTEGER;
  _origin_city_id UUID;
  _candidate_distance NUMERIC;
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
  _max_distance := NULLIF(_filters ->> 'max_distance_km', '')::INTEGER;

  SELECT profile.city_id
  INTO _origin_city_id
  FROM public.client_profiles profile
  WHERE profile.user_id = _client;

  IF _max_distance IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.characters character
    LEFT JOIN public.client_character_preferences preference
      ON preference.client_id = _client
     AND preference.character_id = character.id
    WHERE character.is_active = TRUE
      AND character.is_visible = TRUE
      AND private.discovery_distance_km(_origin_city_id, character.discovery_city_id)
        <= _max_distance
      AND (NOT _favorites_only OR preference.is_favorite IS TRUE)
      AND (NOT _recycled_only OR COALESCE(preference.shown_count, 0) > 0)
      AND (_interest IS NULL OR EXISTS (
        SELECT 1
        FROM unnest(COALESCE(character.interests, ARRAY[]::TEXT[])) interest_name(value)
        WHERE lower(interest_name.value) = _interest
      ))
  ) THEN
    RETURN;
  END IF;

  LOOP
    SELECT base.*
    INTO id, name, avatar_url, fictional_age, short_description, category,
      interests, availability_status, created_at, cycle_id, cycle_number,
      is_liked, is_favorite, conversation_id, is_recycled
    FROM public.get_discovery_characters_base(_filters) base
    LIMIT 1;

    IF NOT FOUND THEN
      RETURN;
    END IF;

    _selected_cycle_id := cycle_id;
    _selected_character_id := id;

    SELECT private.discovery_distance_km(_origin_city_id, character.discovery_city_id)
    INTO _candidate_distance
    FROM public.characters character
    WHERE character.id = _selected_character_id;

    availability_status := private.character_live_availability(
      _selected_character_id,
      availability_status
    );

    IF (NOT _favorites_only OR is_favorite)
      AND (NOT _recycled_only OR is_recycled)
      AND (_interest IS NULL OR EXISTS (
        SELECT 1
        FROM unnest(COALESCE(interests, ARRAY[]::TEXT[])) interest_name(value)
        WHERE lower(interest_name.value) = _interest
      ))
      AND (_max_distance IS NULL OR _candidate_distance <= _max_distance) THEN
      RETURN NEXT;
      RETURN;
    END IF;

    UPDATE public.client_discovery_cycle_items item
    SET action = 'expired', acted_at = now()
    WHERE item.cycle_id = _selected_cycle_id
      AND item.character_id = _selected_character_id
      AND item.action IS NULL;
  END LOOP;
END;
$$;


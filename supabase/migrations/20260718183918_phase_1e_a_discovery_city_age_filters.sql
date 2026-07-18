CREATE TABLE public.discovery_cities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE
    CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  display_name_he TEXT NOT NULL CHECK (char_length(btrim(display_name_he)) > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.characters
  ADD COLUMN discovery_city_id UUID
  REFERENCES public.discovery_cities(id)
  ON DELETE SET NULL;

CREATE INDEX characters_discovery_city_age_idx
  ON public.characters (
    discovery_city_id,
    fictional_age,
    created_at DESC,
    id DESC
  )
  WHERE is_active = TRUE
    AND is_visible = TRUE
    AND discovery_city_id IS NOT NULL;

ALTER TABLE public.discovery_cities ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.discovery_cities FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.discovery_cities TO authenticated;

CREATE POLICY "Authenticated users view active discovery cities"
  ON public.discovery_cities
  FOR SELECT
  TO authenticated
  USING (is_active = TRUE);

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
  _canonical JSONB;
BEGIN
  IF jsonb_typeof(_input) <> 'object' THEN
    RAISE EXCEPTION 'invalid_discovery_filters';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(_input) AS key_name(key)
    WHERE key NOT IN ('min_age', 'max_age', 'city_id')
  ) THEN
    RAISE EXCEPTION 'unsupported_discovery_filter';
  END IF;

  _raw_min_age := _input ->> 'min_age';
  _raw_max_age := _input ->> 'max_age';
  _raw_city_id := _input ->> 'city_id';

  IF _raw_min_age IS NOT NULL THEN
    IF jsonb_typeof(_input -> 'min_age') <> 'number'
      OR _raw_min_age !~ '^\d{1,3}$' THEN
      RAISE EXCEPTION 'invalid_discovery_min_age';
    END IF;

    min_age := _raw_min_age::INTEGER;

    IF min_age < 18 OR min_age > 120 THEN
      RAISE EXCEPTION 'discovery_min_age_out_of_range';
    END IF;
  END IF;

  IF _raw_max_age IS NOT NULL THEN
    IF jsonb_typeof(_input -> 'max_age') <> 'number'
      OR _raw_max_age !~ '^\d{1,3}$' THEN
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
      OR _raw_city_id !~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
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

  _canonical := jsonb_build_object(
    'v', 2,
    'min_age', min_age,
    'max_age', max_age,
    'city_id', city_id
  );

  filter_hash := 'v2:' || md5(_canonical::TEXT);
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION private.normalize_discovery_filters(JSONB)
  FROM PUBLIC, anon, authenticated;

UPDATE public.client_discovery_cycles
SET completed_at = now()
WHERE filter_hash = 'v1:all-active-visible'
  AND completed_at IS NULL;

DROP FUNCTION IF EXISTS public.get_discovery_characters();
DROP FUNCTION IF EXISTS public.set_character_swipe(UUID, TEXT);

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
  _filter_hash TEXT;
  _min_age INTEGER;
  _max_age INTEGER;
  _city_id UUID;
  _cycle_id UUID;
  _cycle_number INTEGER;
  _candidate_id UUID;
  _matching_count INTEGER;
  _liked_at TIMESTAMPTZ;
  _is_favorite BOOLEAN;
  _shown_count INTEGER;
  _conversation_id UUID;
  _item_is_recycled BOOLEAN := FALSE;
BEGIN
  IF _client IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM private.ensure_active_client(_client);

  SELECT n.filter_hash, n.min_age, n.max_age, n.city_id
  INTO _filter_hash, _min_age, _max_age, _city_id
  FROM private.normalize_discovery_filters(_filters) n;

  PERFORM pg_advisory_xact_lock(
    hashtext(_client::TEXT),
    hashtext(_filter_hash)
  );

  SELECT c.id, c.cycle_number
  INTO _cycle_id, _cycle_number
  FROM public.client_discovery_cycles c
  WHERE c.client_id = _client
    AND c.filter_hash = _filter_hash
    AND c.completed_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    SELECT COALESCE(MAX(c.cycle_number), 0) + 1
    INTO _cycle_number
    FROM public.client_discovery_cycles c
    WHERE c.client_id = _client
      AND c.filter_hash = _filter_hash;

    INSERT INTO public.client_discovery_cycles (
      client_id,
      filter_hash,
      cycle_number
    )
    VALUES (_client, _filter_hash, _cycle_number)
    RETURNING public.client_discovery_cycles.id INTO _cycle_id;
  END IF;

  UPDATE public.client_discovery_cycle_items i
  SET action = 'expired',
      acted_at = now()
  FROM public.characters c
  WHERE i.cycle_id = _cycle_id
    AND i.character_id = c.id
    AND i.action IS NULL
    AND (
      c.is_active IS NOT TRUE
      OR c.is_visible IS NOT TRUE
      OR (_city_id IS NOT NULL AND c.discovery_city_id IS DISTINCT FROM _city_id)
      OR (_min_age IS NOT NULL AND (c.fictional_age IS NULL OR c.fictional_age < _min_age))
      OR (_max_age IS NOT NULL AND (c.fictional_age IS NULL OR c.fictional_age > _max_age))
    );

  SELECT i.character_id, i.is_recycled
  INTO _candidate_id, _item_is_recycled
  FROM public.client_discovery_cycle_items i
  JOIN public.characters c ON c.id = i.character_id
  WHERE i.cycle_id = _cycle_id
    AND i.action IS NULL
    AND c.is_active = TRUE
    AND c.is_visible = TRUE
    AND (_city_id IS NULL OR c.discovery_city_id = _city_id)
    AND (_min_age IS NULL OR c.fictional_age >= _min_age)
    AND (_max_age IS NULL OR c.fictional_age <= _max_age)
  ORDER BY i.shown_at ASC
  LIMIT 1;

  IF _candidate_id IS NULL THEN
    LOOP
      SELECT c.id
      INTO _candidate_id
      FROM public.characters c
      LEFT JOIN public.client_character_preferences p
        ON p.client_id = _client
       AND p.character_id = c.id
      WHERE c.is_active = TRUE
        AND c.is_visible = TRUE
        AND (_city_id IS NULL OR c.discovery_city_id = _city_id)
        AND (_min_age IS NULL OR c.fictional_age >= _min_age)
        AND (_max_age IS NULL OR c.fictional_age <= _max_age)
        AND NOT EXISTS (
          SELECT 1
          FROM public.client_discovery_cycle_items i
          WHERE i.cycle_id = _cycle_id
            AND i.character_id = c.id
        )
      ORDER BY
        CASE WHEN COALESCE(p.shown_count, 0) = 0 THEN 0 ELSE 1 END,
        CASE WHEN COALESCE(p.shown_count, 0) = 0 THEN c.created_at END DESC NULLS LAST,
        md5(_cycle_id::TEXT || ':' || c.id::TEXT)
      LIMIT 1;

      EXIT WHEN _candidate_id IS NOT NULL;

      SELECT COUNT(*)
      INTO _matching_count
      FROM public.characters c
      WHERE c.is_active = TRUE
        AND c.is_visible = TRUE
        AND (_city_id IS NULL OR c.discovery_city_id = _city_id)
        AND (_min_age IS NULL OR c.fictional_age >= _min_age)
        AND (_max_age IS NULL OR c.fictional_age <= _max_age);

      IF _matching_count = 0 THEN
        RETURN;
      END IF;

      UPDATE public.client_discovery_cycles
      SET completed_at = now()
      WHERE public.client_discovery_cycles.id = _cycle_id;

      _cycle_number := _cycle_number + 1;

      INSERT INTO public.client_discovery_cycles (
        client_id,
        filter_hash,
        cycle_number
      )
      VALUES (_client, _filter_hash, _cycle_number)
      RETURNING public.client_discovery_cycles.id INTO _cycle_id;
    END LOOP;

    SELECT p.liked_at, p.is_favorite, p.shown_count
    INTO _liked_at, _is_favorite, _shown_count
    FROM public.client_character_preferences p
    WHERE p.client_id = _client
      AND p.character_id = _candidate_id;

    _item_is_recycled := COALESCE(_shown_count, 0) > 0;

    INSERT INTO public.client_character_preferences AS p (
      client_id,
      character_id,
      last_seen_at,
      shown_count
    )
    VALUES (_client, _candidate_id, now(), 1)
    ON CONFLICT (client_id, character_id) DO UPDATE
    SET last_seen_at = EXCLUDED.last_seen_at,
        shown_count = p.shown_count + 1;

    INSERT INTO public.client_discovery_cycle_items (
      cycle_id,
      character_id,
      is_recycled
    )
    VALUES (_cycle_id, _candidate_id, _item_is_recycled);
  ELSE
    SELECT p.liked_at, p.is_favorite
    INTO _liked_at, _is_favorite
    FROM public.client_character_preferences p
    WHERE p.client_id = _client
      AND p.character_id = _candidate_id;
  END IF;

  SELECT c.id
  INTO _conversation_id
  FROM public.conversations c
  WHERE c.client_id = _client
    AND c.character_id = _candidate_id
    AND c.status <> 'closed'::public.conversation_status
    AND c.client_hidden_at IS NULL;

  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c.avatar_url,
    c.fictional_age,
    c.short_description,
    c.category,
    c.interests,
    c.availability_status,
    c.created_at,
    _cycle_id,
    _cycle_number,
    COALESCE(_liked_at IS NOT NULL, FALSE),
    COALESCE(_is_favorite, FALSE),
    _conversation_id,
    _item_is_recycled
  FROM public.characters c
  WHERE c.id = _candidate_id;
END;
$$;

CREATE FUNCTION public.set_character_swipe(
  _character_id UUID,
  _cycle_id UUID,
  _filters JSONB,
  _swipe TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _client UUID := auth.uid();
  _expected_hash TEXT;
  _cycle_hash TEXT;
  _min_age INTEGER;
  _max_age INTEGER;
  _city_id UUID;
  _requested_action TEXT := lower(btrim(COALESCE(_swipe, '')));
  _stored_action TEXT;
  _liked_at TIMESTAMPTZ;
  _character_available BOOLEAN;
  _first_like BOOLEAN := FALSE;
BEGIN
  IF _client IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM private.ensure_active_client(_client);

  IF _requested_action NOT IN ('like', 'pass') THEN
    RAISE EXCEPTION 'invalid_swipe';
  END IF;

  SELECT n.filter_hash, n.min_age, n.max_age, n.city_id
  INTO _expected_hash, _min_age, _max_age, _city_id
  FROM private.normalize_discovery_filters(_filters) n;

  SELECT c.filter_hash
  INTO _cycle_hash
  FROM public.client_discovery_cycles c
  WHERE c.id = _cycle_id
    AND c.client_id = _client;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_discovery_cycle';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(_client::TEXT),
    hashtext(_cycle_hash)
  );

  SELECT c.filter_hash
  INTO _cycle_hash
  FROM public.client_discovery_cycles c
  WHERE c.id = _cycle_id
    AND c.client_id = _client
    AND c.completed_at IS NULL
  FOR UPDATE;

  IF NOT FOUND OR _cycle_hash <> _expected_hash THEN
    RAISE EXCEPTION 'stale_discovery_cycle';
  END IF;

  SELECT i.action
  INTO _stored_action
  FROM public.client_discovery_cycle_items i
  WHERE i.cycle_id = _cycle_id
    AND i.character_id = _character_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'character_not_in_current_discovery_cycle';
  END IF;

  IF _stored_action IS NOT NULL THEN
    IF _stored_action = _requested_action THEN
      SELECT p.liked_at
      INTO _liked_at
      FROM public.client_character_preferences p
      WHERE p.client_id = _client
        AND p.character_id = _character_id;

      RETURN jsonb_build_object(
        'character_id', _character_id,
        'action', _stored_action,
        'is_liked', COALESCE(_liked_at IS NOT NULL, FALSE),
        'first_like', FALSE,
        'idempotent', TRUE
      );
    END IF;

    RAISE EXCEPTION 'discovery_action_already_recorded';
  END IF;

  SELECT (
    c.is_active IS TRUE
    AND c.is_visible IS TRUE
    AND (_city_id IS NULL OR c.discovery_city_id = _city_id)
    AND (_min_age IS NULL OR c.fictional_age >= _min_age)
    AND (_max_age IS NULL OR c.fictional_age <= _max_age)
  )
  INTO _character_available
  FROM public.characters c
  WHERE c.id = _character_id;

  IF _character_available IS NOT TRUE THEN
    UPDATE public.client_discovery_cycle_items
    SET action = 'expired',
        acted_at = now()
    WHERE cycle_id = _cycle_id
      AND character_id = _character_id;

    RAISE EXCEPTION 'character_not_available';
  END IF;

  IF _requested_action = 'like' THEN
    SELECT p.liked_at
    INTO _liked_at
    FROM public.client_character_preferences p
    WHERE p.client_id = _client
      AND p.character_id = _character_id
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.client_character_preferences (
        client_id,
        character_id,
        liked_at,
        last_seen_at,
        shown_count
      )
      VALUES (_client, _character_id, now(), now(), 1)
      RETURNING liked_at INTO _liked_at;

      _first_like := TRUE;
    ELSIF _liked_at IS NULL THEN
      UPDATE public.client_character_preferences
      SET liked_at = now()
      WHERE client_id = _client
        AND character_id = _character_id
      RETURNING liked_at INTO _liked_at;

      IF _liked_at IS NULL THEN
        RAISE EXCEPTION 'discovery_preference_invariant_failed';
      END IF;

      _first_like := TRUE;
    END IF;
  ELSE
    SELECT p.liked_at
    INTO _liked_at
    FROM public.client_character_preferences p
    WHERE p.client_id = _client
      AND p.character_id = _character_id;
  END IF;

  UPDATE public.client_discovery_cycle_items
  SET action = _requested_action,
      acted_at = now()
  WHERE cycle_id = _cycle_id
    AND character_id = _character_id;

  RETURN jsonb_build_object(
    'character_id', _character_id,
    'action', _requested_action,
    'is_liked', COALESCE(_liked_at IS NOT NULL, FALSE),
    'first_like', _first_like,
    'idempotent', FALSE
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_characters(JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_character_swipe(UUID, UUID, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_discovery_characters(JSONB)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_character_swipe(UUID, UUID, JSONB, TEXT)
  TO authenticated;

ALTER TABLE public.client_character_preferences
  ADD COLUMN liked_at TIMESTAMPTZ,
  ADD COLUMN last_seen_at TIMESTAMPTZ,
  ADD COLUMN shown_count INTEGER NOT NULL DEFAULT 0
    CHECK (shown_count >= 0);

UPDATE public.client_character_preferences
SET
  liked_at = CASE
    WHEN swipe = 'like' THEN COALESCE(swiped_at, updated_at, created_at)
    ELSE NULL
  END,
  last_seen_at = CASE
    WHEN swipe IS NOT NULL THEN COALESCE(swiped_at, updated_at, created_at)
    ELSE NULL
  END,
  shown_count = CASE
    WHEN swipe IS NOT NULL THEN GREATEST(shown_count, 1)
    ELSE shown_count
  END
WHERE swipe IS NOT NULL;

DROP INDEX IF EXISTS public.client_character_preferences_client_swipe_idx;

ALTER TABLE public.client_character_preferences
  DROP CONSTRAINT IF EXISTS client_character_preferences_swiped_at_check,
  DROP CONSTRAINT IF EXISTS client_character_preferences_swipe_check,
  DROP COLUMN swipe,
  DROP COLUMN swiped_at;

CREATE INDEX client_character_preferences_client_liked_idx
  ON public.client_character_preferences (client_id, liked_at DESC, character_id)
  WHERE liked_at IS NOT NULL;

CREATE INDEX client_character_preferences_client_seen_idx
  ON public.client_character_preferences (client_id, last_seen_at DESC, character_id);

CREATE TABLE public.client_discovery_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  filter_hash TEXT NOT NULL CHECK (char_length(filter_hash) BETWEEN 1 AND 128),
  cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT client_discovery_cycles_unique_number
    UNIQUE (client_id, filter_hash, cycle_number),
  CONSTRAINT client_discovery_cycles_completion_check
    CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE UNIQUE INDEX client_discovery_cycles_one_open_idx
  ON public.client_discovery_cycles (client_id, filter_hash)
  WHERE completed_at IS NULL;

CREATE TABLE public.client_discovery_cycle_items (
  cycle_id UUID NOT NULL REFERENCES public.client_discovery_cycles(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  shown_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_recycled BOOLEAN NOT NULL DEFAULT FALSE,
  action TEXT,
  acted_at TIMESTAMPTZ,
  PRIMARY KEY (cycle_id, character_id),
  CONSTRAINT client_discovery_cycle_items_action_check
    CHECK (action IN ('like', 'pass', 'expired') OR action IS NULL),
  CONSTRAINT client_discovery_cycle_items_acted_at_check
    CHECK (
      (action IS NULL AND acted_at IS NULL)
      OR (action IS NOT NULL AND acted_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX client_discovery_cycle_items_one_open_per_cycle_idx
  ON public.client_discovery_cycle_items (cycle_id)
  WHERE action IS NULL;

ALTER TABLE public.client_discovery_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_discovery_cycle_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.client_discovery_cycles
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.client_discovery_cycle_items
  FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.get_discovery_characters(
  INTEGER,
  TIMESTAMPTZ,
  UUID
);

CREATE FUNCTION public.get_discovery_characters()
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
  _filter_hash TEXT := 'v1:all-active-visible';
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
    RETURNING id INTO _cycle_id;
  END IF;

  UPDATE public.client_discovery_cycle_items i
  SET action = 'expired',
      acted_at = now()
  FROM public.characters c
  WHERE i.cycle_id = _cycle_id
    AND i.character_id = c.id
    AND i.action IS NULL
    AND (c.is_active IS NOT TRUE OR c.is_visible IS NOT TRUE);

  SELECT i.character_id, i.is_recycled
  INTO _candidate_id, _item_is_recycled
  FROM public.client_discovery_cycle_items i
  JOIN public.characters c ON c.id = i.character_id
  WHERE i.cycle_id = _cycle_id
    AND i.action IS NULL
    AND c.is_active = TRUE
    AND c.is_visible = TRUE
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
        AND NOT EXISTS (
          SELECT 1
          FROM public.client_discovery_cycle_items i
          WHERE i.cycle_id = _cycle_id
            AND i.character_id = c.id
        )
      ORDER BY
        CASE WHEN COALESCE(p.shown_count, 0) = 0 THEN 0 ELSE 1 END,
        CASE
          WHEN COALESCE(p.shown_count, 0) = 0 THEN c.created_at
          ELSE NULL
        END DESC NULLS LAST,
        md5(_cycle_id::TEXT || ':' || c.id::TEXT)
      LIMIT 1;

      EXIT WHEN _candidate_id IS NOT NULL;

      SELECT COUNT(*)
      INTO _matching_count
      FROM public.characters c
      WHERE c.is_active = TRUE
        AND c.is_visible = TRUE;

      IF _matching_count = 0 THEN
        RETURN;
      END IF;

      UPDATE public.client_discovery_cycles
      SET completed_at = now()
      WHERE id = _cycle_id;

      _cycle_number := _cycle_number + 1;

      INSERT INTO public.client_discovery_cycles (
        client_id,
        filter_hash,
        cycle_number
      )
      VALUES (_client, _filter_hash, _cycle_number)
      RETURNING id INTO _cycle_id;
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

CREATE OR REPLACE FUNCTION public.set_character_swipe(
  _character_id UUID,
  _swipe TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _client UUID := auth.uid();
  _filter_hash TEXT := 'v1:all-active-visible';
  _requested_action TEXT := lower(btrim(COALESCE(_swipe, '')));
  _cycle_id UUID;
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

  PERFORM pg_advisory_xact_lock(
    hashtext(_client::TEXT),
    hashtext(_filter_hash)
  );

  SELECT c.id
  INTO _cycle_id
  FROM public.client_discovery_cycles c
  WHERE c.client_id = _client
    AND c.filter_hash = _filter_hash
    AND c.completed_at IS NULL
  FOR UPDATE;

  IF _cycle_id IS NULL THEN
    RAISE EXCEPTION 'discovery_cycle_not_started';
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

  SELECT c.is_active AND c.is_visible
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
      VALUES (
        _client,
        _character_id,
        now(),
        now(),
        1
      )
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

CREATE OR REPLACE FUNCTION public.set_character_favorite(
  _character_id UUID,
  _is_favorite BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  _client UUID := auth.uid();
  _character_available BOOLEAN;
  _changed BOOLEAN := FALSE;
BEGIN
  IF _client IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM private.ensure_active_client(_client);

  IF _is_favorite IS DISTINCT FROM TRUE THEN
    UPDATE public.client_character_preferences
    SET is_favorite = FALSE,
        favorited_at = NULL
    WHERE client_id = _client
      AND character_id = _character_id
      AND is_favorite = TRUE
    RETURNING TRUE INTO _changed;

    RETURN jsonb_build_object(
      'character_id', _character_id,
      'is_favorite', FALSE,
      'idempotent', NOT COALESCE(_changed, FALSE)
    );
  END IF;

  SELECT c.is_active AND c.is_visible
  INTO _character_available
  FROM public.characters c
  WHERE c.id = _character_id;

  IF _character_available IS NOT TRUE THEN
    RAISE EXCEPTION 'character_not_available';
  END IF;

  INSERT INTO public.client_character_preferences AS p (
    client_id,
    character_id,
    is_favorite,
    favorited_at
  )
  VALUES (_client, _character_id, TRUE, now())
  ON CONFLICT (client_id, character_id) DO UPDATE
  SET is_favorite = TRUE,
      favorited_at = COALESCE(p.favorited_at, EXCLUDED.favorited_at)
  WHERE p.is_favorite = FALSE
  RETURNING TRUE INTO _changed;

  RETURN jsonb_build_object(
    'character_id', _character_id,
    'is_favorite', TRUE,
    'idempotent', NOT COALESCE(_changed, FALSE)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_characters()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_character_swipe(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_character_favorite(UUID, BOOLEAN)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_discovery_characters()
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_character_swipe(UUID, TEXT)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_character_favorite(UUID, BOOLEAN)
  TO authenticated;

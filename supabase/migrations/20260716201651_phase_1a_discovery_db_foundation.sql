CREATE TABLE public.client_character_preferences (
  client_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  character_id UUID NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  swipe TEXT,
  swiped_at TIMESTAMPTZ,
  is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
  favorited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, character_id),
  CONSTRAINT client_character_preferences_swipe_check CHECK (swipe IN ('like', 'pass') OR swipe IS NULL),
  CONSTRAINT client_character_preferences_swiped_at_check CHECK (
    (swipe IS NULL AND swiped_at IS NULL)
    OR (swipe IS NOT NULL AND swiped_at IS NOT NULL)
  )
);

CREATE INDEX client_character_preferences_client_swipe_idx
  ON public.client_character_preferences (client_id, character_id)
  WHERE swipe IS NOT NULL;

CREATE INDEX client_character_preferences_client_favorite_idx
  ON public.client_character_preferences (client_id, favorited_at DESC, character_id)
  WHERE is_favorite = TRUE;

CREATE INDEX characters_discovery_eligible_order_idx
  ON public.characters (created_at DESC, id DESC)
  WHERE is_active = TRUE AND is_visible = TRUE;

CREATE TRIGGER set_client_character_preferences_updated_at
  BEFORE UPDATE ON public.client_character_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.client_character_preferences ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.client_character_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.client_character_preferences TO authenticated;

CREATE POLICY "Clients view own character preferences"
  ON public.client_character_preferences
  FOR SELECT
  TO authenticated
  USING ((select auth.uid()) = client_id);

CREATE OR REPLACE FUNCTION public.get_discovery_characters(
  _limit INTEGER DEFAULT 20,
  _cursor_created_at TIMESTAMPTZ DEFAULT NULL,
  _cursor_id UUID DEFAULT NULL
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
  created_at TIMESTAMPTZ
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

  IF _limit IS NULL OR _limit < 1 OR _limit > 50 THEN
    RAISE EXCEPTION 'invalid_discovery_limit';
  END IF;

  IF (_cursor_created_at IS NULL) <> (_cursor_id IS NULL) THEN
    RAISE EXCEPTION 'invalid_discovery_cursor';
  END IF;

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
    c.created_at
  FROM public.characters c
  WHERE c.is_active = TRUE
    AND c.is_visible = TRUE
    AND NOT EXISTS (
      SELECT 1
      FROM public.client_character_preferences p
      WHERE p.client_id = _client
        AND p.character_id = c.id
        AND p.swipe IS NOT NULL
    )
    AND (
      _cursor_created_at IS NULL
      OR (c.created_at, c.id) < (_cursor_created_at, _cursor_id)
    )
  ORDER BY c.created_at DESC, c.id DESC
  LIMIT _limit;
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
  _requested_swipe TEXT := lower(btrim(COALESCE(_swipe, '')));
  _stored_swipe TEXT;
  _character_available BOOLEAN;
BEGIN
  IF _client IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM private.ensure_active_client(_client);

  IF _requested_swipe NOT IN ('like', 'pass') THEN
    RAISE EXCEPTION 'invalid_swipe';
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
    swipe,
    swiped_at
  )
  VALUES (
    _client,
    _character_id,
    _requested_swipe,
    now()
  )
  ON CONFLICT (client_id, character_id) DO UPDATE
  SET swipe = EXCLUDED.swipe,
      swiped_at = EXCLUDED.swiped_at
  WHERE p.swipe IS NULL
  RETURNING swipe INTO _stored_swipe;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'character_id', _character_id,
      'swipe', _stored_swipe,
      'idempotent', FALSE
    );
  END IF;

  SELECT p.swipe
  INTO _stored_swipe
  FROM public.client_character_preferences p
  WHERE p.client_id = _client
    AND p.character_id = _character_id;

  IF _stored_swipe = _requested_swipe THEN
    RETURN jsonb_build_object(
      'character_id', _character_id,
      'swipe', _stored_swipe,
      'idempotent', TRUE
    );
  END IF;

  RAISE EXCEPTION 'swipe_already_recorded';
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
  _is_already_favorite BOOLEAN;
BEGIN
  IF _client IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  PERFORM private.ensure_active_client(_client);

  IF _is_favorite IS DISTINCT FROM TRUE THEN
    SELECT p.is_favorite
    INTO _is_already_favorite
    FROM public.client_character_preferences p
    WHERE p.client_id = _client
      AND p.character_id = _character_id;

    IF COALESCE(_is_already_favorite, FALSE) IS FALSE THEN
      RETURN jsonb_build_object(
        'character_id', _character_id,
        'is_favorite', FALSE,
        'idempotent', TRUE
      );
    END IF;

    UPDATE public.client_character_preferences
    SET is_favorite = FALSE,
        favorited_at = NULL
    WHERE client_id = _client
      AND character_id = _character_id;

    DELETE FROM public.client_character_preferences
    WHERE client_id = _client
      AND character_id = _character_id
      AND swipe IS NULL
      AND is_favorite = FALSE;

    RETURN jsonb_build_object(
      'character_id', _character_id,
      'is_favorite', FALSE,
      'idempotent', FALSE
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
  VALUES (
    _client,
    _character_id,
    TRUE,
    now()
  )
  ON CONFLICT (client_id, character_id) DO UPDATE
  SET is_favorite = TRUE,
      favorited_at = COALESCE(p.favorited_at, EXCLUDED.favorited_at)
  WHERE p.is_favorite IS FALSE
  RETURNING is_favorite INTO _is_already_favorite;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'character_id', _character_id,
      'is_favorite', _is_already_favorite,
      'idempotent', FALSE
    );
  END IF;

  RETURN jsonb_build_object(
    'character_id', _character_id,
    'is_favorite', TRUE,
    'idempotent', TRUE
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_discovery_characters(INTEGER, TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_character_swipe(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_character_favorite(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_discovery_characters(INTEGER, TIMESTAMPTZ, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_character_swipe(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_character_favorite(UUID, BOOLEAN) TO authenticated;

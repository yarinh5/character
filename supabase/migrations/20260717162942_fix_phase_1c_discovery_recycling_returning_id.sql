CREATE OR REPLACE FUNCTION public.get_discovery_characters()
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
    RETURNING public.client_discovery_cycles.id INTO _cycle_id;
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

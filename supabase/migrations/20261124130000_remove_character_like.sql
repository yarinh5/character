CREATE FUNCTION public.remove_character_like(_character_id uuid, _expected_subject uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  _client uuid := auth.uid();
BEGIN
  IF _client IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF _expected_subject IS DISTINCT FROM _client THEN
    RAISE EXCEPTION 'client_identity_changed' USING ERRCODE = '42501';
  END IF;
  PERFORM private.ensure_active_client(_client);

  -- Like Favorite removal, withdrawal does not depend on the target still being visible.
  -- Only a real transition fires P07; an absent mark is never inserted or rewritten.
  UPDATE public.client_character_preferences p
  SET liked_at = NULL
  WHERE p.client_id = _client AND p.character_id = _character_id AND p.liked_at IS NOT NULL;
  RETURN jsonb_build_object('character_id', _character_id, 'is_liked', false, 'idempotent', NOT FOUND);
END;
$$;
REVOKE ALL ON FUNCTION public.remove_character_like(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.remove_character_like(uuid, uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';

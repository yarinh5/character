DO $$
DECLARE
  _function_definition TEXT;
BEGIN
  SELECT pg_get_functiondef('public.get_discovery_characters()'::regprocedure)
  INTO _function_definition;

  IF position('WHERE id = _cycle_id;' IN _function_definition) = 0 THEN
    RAISE EXCEPTION 'Expected unqualified cycle update was not found';
  END IF;

  EXECUTE replace(
    _function_definition,
    'WHERE id = _cycle_id;',
    'WHERE public.client_discovery_cycles.id = _cycle_id;'
  );
END;
$$;

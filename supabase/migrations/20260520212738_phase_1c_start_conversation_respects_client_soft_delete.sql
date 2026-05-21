-- Frontend switch support: reopening a character after client-side soft delete
-- creates a new visible client thread while preserving operator/admin history.

CREATE OR REPLACE FUNCTION public.start_or_get_conversation(_character_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _client UUID := auth.uid();
  _conv_id UUID;
  _operator UUID;
  _char_active BOOLEAN;
BEGIN
  IF _client IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT (is_active AND is_visible)
  INTO _char_active
  FROM public.characters
  WHERE id = _character_id;

  IF _char_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Character not available';
  END IF;

  SELECT c.id
  INTO _conv_id
  FROM public.conversations c
  WHERE c.client_id = _client
    AND c.character_id = _character_id
    AND c.status <> 'closed'::public.conversation_status
    AND NOT EXISTS (
      SELECT 1
      FROM public.client_conversation_deletions d
      WHERE d.client_id = _client
        AND d.conversation_id = c.id
    )
  ORDER BY c.created_at DESC
  LIMIT 1;

  IF _conv_id IS NOT NULL THEN
    RETURN _conv_id;
  END IF;

  SELECT o.id
  INTO _operator
  FROM public.operators o
  JOIN public.character_operator_assignments coa ON coa.operator_id = o.id
  WHERE coa.character_id = _character_id
    AND o.is_active = true
  ORDER BY o.availability_status = 'available' DESC,
           (
             SELECT COUNT(*)
             FROM public.conversations c
             WHERE c.assigned_operator_id = o.id
               AND c.status <> 'closed'::public.conversation_status
           ) ASC
  LIMIT 1;

  INSERT INTO public.conversations (client_id, character_id, assigned_operator_id, status)
  VALUES (
    _client,
    _character_id,
    _operator,
    CASE
      WHEN _operator IS NULL THEN 'waiting'::public.conversation_status
      ELSE 'open'::public.conversation_status
    END
  )
  RETURNING id INTO _conv_id;

  RETURN _conv_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.start_or_get_conversation(UUID) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.start_or_get_conversation(UUID) TO authenticated;

-- V2-14 follow-up: RLS policies are row-level only, so Operators must not read
-- client_profiles directly after onboarding PII columns were added.

DROP POLICY IF EXISTS "Operators view client_profile for own conversations"
  ON public.client_profiles;

REVOKE ALL ON TABLE public.client_profiles FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.client_profiles TO authenticated;

CREATE OR REPLACE FUNCTION public.get_operator_conversation_client_profile(
  _conversation_id UUID
)
RETURNS TABLE (
  age INTEGER,
  interests TEXT[],
  conversation_preferences TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _operator_id UUID;
BEGIN
  SELECT o.id
  INTO _operator_id
  FROM public.operators o
  WHERE o.user_id = (SELECT auth.uid())
    AND o.is_active = true
  LIMIT 1;

  IF _operator_id IS NULL THEN
    RAISE EXCEPTION 'operator_profile_required'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.character_operator_assignments coa
      ON coa.character_id = c.character_id
    WHERE c.id = _conversation_id
      AND coa.operator_id = _operator_id
  ) THEN
    RAISE EXCEPTION 'operator_not_assigned_to_conversation_character'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    cp.age,
    cp.interests,
    cp.conversation_preferences
  FROM public.conversations c
  LEFT JOIN public.client_profiles cp
    ON cp.user_id = c.client_id
  WHERE c.id = _conversation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_operator_conversation_client_profile(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_operator_conversation_client_profile(UUID)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

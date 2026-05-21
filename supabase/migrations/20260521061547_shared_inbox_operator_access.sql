-- Shared inbox: operators access conversations by assigned character, not assigned_operator_id.
-- assigned_operator_id stays in place as legacy metadata.

CREATE OR REPLACE FUNCTION public.is_conversation_operator(_conversation_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.character_operator_assignments coa
      ON coa.character_id = c.character_id
    JOIN public.operators o
      ON o.id = coa.operator_id
    WHERE c.id = _conversation_id
      AND o.user_id = auth.uid()
      AND o.is_active = true
  );
$$;

CREATE OR REPLACE FUNCTION public.mark_conversation_read(_conversation_id UUID, _as TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _as = 'client' AND public.is_conversation_client(_conversation_id) THEN
    UPDATE public.conversations SET client_unread_count = 0 WHERE id = _conversation_id;
    UPDATE public.messages SET is_read = true
      WHERE conversation_id = _conversation_id AND sender_type <> 'client';
  ELSIF _as = 'operator' AND (public.is_conversation_operator(_conversation_id) OR public.is_admin()) THEN
    UPDATE public.conversations SET operator_unread_count = 0 WHERE id = _conversation_id;
    UPDATE public.messages SET is_read = true
      WHERE conversation_id = _conversation_id AND sender_type = 'client';
  END IF;
END;
$$;

DROP POLICY IF EXISTS "Operators view client profiles in their conversations" ON public.profiles;
CREATE POLICY "Operators view client profiles in their conversations" ON public.profiles FOR SELECT
  USING (
    public.is_operator()
    AND EXISTS (
      SELECT 1
      FROM public.conversations c
      JOIN public.character_operator_assignments coa
        ON coa.character_id = c.character_id
      JOIN public.operators o
        ON o.id = coa.operator_id
      WHERE c.client_id = profiles.user_id
        AND o.user_id = auth.uid()
        AND o.is_active = true
    )
  );

DROP POLICY IF EXISTS "Operators view client_profile for own conversations" ON public.client_profiles;
CREATE POLICY "Operators view client_profile for own conversations" ON public.client_profiles FOR SELECT
  USING (
    public.is_operator()
    AND EXISTS (
      SELECT 1
      FROM public.conversations c
      JOIN public.character_operator_assignments coa
        ON coa.character_id = c.character_id
      JOIN public.operators o
        ON o.id = coa.operator_id
      WHERE c.client_id = client_profiles.user_id
        AND o.user_id = auth.uid()
        AND o.is_active = true
    )
  );

DROP POLICY IF EXISTS "Operators view assigned conversations" ON public.conversations;
CREATE POLICY "Operators view assigned conversations" ON public.conversations FOR SELECT
  USING (public.is_conversation_operator(id));

DROP POLICY IF EXISTS "Operators update assigned conversations" ON public.conversations;
CREATE POLICY "Operators update assigned conversations" ON public.conversations FOR UPDATE
  USING (public.is_conversation_operator(id))
  WITH CHECK (public.is_conversation_operator(id));

DROP POLICY IF EXISTS "Operators view notes in assigned conversations" ON public.internal_notes;
CREATE POLICY "Operators view notes in assigned conversations" ON public.internal_notes FOR SELECT
  USING (public.is_conversation_operator(conversation_id));

DROP POLICY IF EXISTS "Operators insert notes in assigned conversations" ON public.internal_notes;
CREATE POLICY "Operators insert notes in assigned conversations" ON public.internal_notes FOR INSERT
  WITH CHECK (public.is_conversation_operator(conversation_id) AND operator_id = public.get_my_operator_id());

CREATE POLICY "Operators view co-assigned operators"
  ON public.operators FOR SELECT
  USING (
    public.is_operator()
    AND EXISTS (
      SELECT 1
      FROM public.character_operator_assignments mine
      JOIN public.operators me
        ON me.id = mine.operator_id
      JOIN public.character_operator_assignments theirs
        ON theirs.character_id = mine.character_id
      WHERE me.user_id = auth.uid()
        AND me.is_active = true
        AND theirs.operator_id = operators.id
    )
  );

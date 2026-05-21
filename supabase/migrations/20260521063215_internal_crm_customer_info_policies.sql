-- Internal CRM polish: align customer info and notes permissions with shared inbox.

DROP POLICY IF EXISTS "Admins view all notes" ON public.internal_notes;
CREATE POLICY "Admins manage all notes"
  ON public.internal_notes FOR ALL
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Operators view customer info for assigned characters" ON public.customer_info_entries;
CREATE POLICY "Operators view customer info for assigned characters"
  ON public.customer_info_entries FOR SELECT
  USING (
    operator_id = public.get_my_operator_id()
    OR public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.conversations c
      WHERE c.client_id = customer_info_entries.client_id
        AND (
          customer_info_entries.conversation_id IS NULL
          OR customer_info_entries.conversation_id = c.id
        )
        AND public.is_conversation_operator(c.id)
    )
  );

DROP POLICY IF EXISTS "Operators create customer info for assigned characters" ON public.customer_info_entries;
CREATE POLICY "Operators create customer info for assigned characters"
  ON public.customer_info_entries FOR INSERT
  WITH CHECK (
    created_by_user_id = auth.uid()
    AND operator_id = public.get_my_operator_id()
    AND (
      (
        conversation_id IS NOT NULL
        AND public.is_conversation_operator(conversation_id)
        AND EXISTS (
          SELECT 1
          FROM public.conversations c
          WHERE c.id = conversation_id
            AND c.client_id = customer_info_entries.client_id
        )
      )
      OR (
        conversation_id IS NULL
        AND EXISTS (
          SELECT 1
          FROM public.conversations c
          WHERE c.client_id = customer_info_entries.client_id
            AND public.is_conversation_operator(c.id)
        )
      )
    )
  );

DO $$
BEGIN
  ALTER TABLE public.customer_info_entries REPLICA IDENTITY FULL;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'customer_info_entries'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.customer_info_entries;
  END IF;
END $$;

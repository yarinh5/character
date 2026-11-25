-- Operators may edit their own display name and availability, but not authority fields.
REVOKE UPDATE ON TABLE public.operators FROM PUBLIC, anon, authenticated;
GRANT UPDATE (full_name, availability_status) ON TABLE public.operators TO authenticated;

DROP POLICY IF EXISTS "Operators update self" ON public.operators;
CREATE POLICY "Operators update self" ON public.operators
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id AND is_active IS TRUE AND deleted_at IS NULL)
  WITH CHECK (auth.uid() = user_id AND is_active IS TRUE AND deleted_at IS NULL);

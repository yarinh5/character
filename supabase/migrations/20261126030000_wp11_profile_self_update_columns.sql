-- Account state, email and avatar are managed by server-owned workflows.
REVOKE UPDATE ON TABLE public.profiles FROM PUBLIC, anon, authenticated;
GRANT UPDATE (display_name) ON TABLE public.profiles TO authenticated;

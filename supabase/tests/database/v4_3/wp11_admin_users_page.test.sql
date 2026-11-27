BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SELECT no_plan();

SELECT has_function('public', 'admin_list_users_page',
  ARRAY['text', 'text', 'text', 'timestamp with time zone', 'uuid', 'integer'],
  'Admin user directory exposes a bounded page contract');
SELECT ok(NOT has_function_privilege('public',
  'public.admin_list_users_page(text,text,text,timestamptz,uuid,integer)', 'EXECUTE'),
  'PUBLIC cannot execute the user directory');
SET LOCAL ROLE anon;
SELECT ok(NOT has_function_privilege(current_user,
  'public.admin_list_users_page(text,text,text,timestamptz,uuid,integer)', 'EXECUTE'),
  'Anon cannot execute the user directory');
RESET ROLE;

INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data) VALUES
  ('00000000-0000-4000-8000-000000119201', 'authenticated', 'authenticated', 'users-admin@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119202', 'authenticated', 'authenticated', 'users-mixed@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119203', 'authenticated', 'authenticated', 'users-client@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119204', 'authenticated', 'authenticated', 'users-operator@example.invalid', '{}', '{}'),
  ('00000000-0000-4000-8000-000000119205', 'authenticated', 'authenticated', 'users-orphan@example.invalid', '{}', '{}');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-4000-8000-000000119201', 'admin'),
  ('00000000-0000-4000-8000-000000119202', 'operator'),
  ('00000000-0000-4000-8000-000000119204', 'operator');
DELETE FROM public.user_roles
WHERE user_id = '00000000-0000-4000-8000-000000119205';
UPDATE public.profiles SET created_at = '2099-04-05', display_name = 'No role'
WHERE user_id = '00000000-0000-4000-8000-000000119205';
UPDATE public.profiles SET created_at = '2099-04-04', display_name = 'Blocked operator', status = 'blocked'
WHERE user_id = '00000000-0000-4000-8000-000000119204';
UPDATE public.profiles SET created_at = '2099-04-03', display_name = 'Under%score'
WHERE user_id = '00000000-0000-4000-8000-000000119203';
UPDATE public.profiles SET created_at = '2099-04-03', display_name = 'Mixed roles'
WHERE user_id = '00000000-0000-4000-8000-000000119202';
UPDATE public.profiles SET created_at = '2099-04-01', display_name = 'Admin'
WHERE user_id = '00000000-0000-4000-8000-000000119201';

SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.role" = 'authenticated';
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119203';
SELECT throws_like($$SELECT * FROM public.admin_list_users_page()$$,
  'admin_required', 'Client cannot list users');
SET LOCAL "request.jwt.claim.sub" = '00000000-0000-4000-8000-000000119201';
SELECT throws_like($$SELECT * FROM public.admin_list_users_page(_role => 'unknown')$$,
  'invalid_user_filter', 'Unknown role filter is rejected');
SELECT throws_like($$SELECT * FROM public.admin_list_users_page(_page_size => 102)$$,
  'invalid_page_size', 'Page size above 101 is rejected');
SELECT throws_like($$SELECT * FROM public.admin_list_users_page(_before_created_at => now())$$,
  'invalid_user_cursor', 'Partial cursor is rejected');
SELECT throws_like($$SELECT * FROM public.admin_list_users_page(_search => repeat('x', 121))$$,
  'invalid_user_search', 'Search above 120 characters is rejected');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_users_page(_page_size => 3)$$,
  $$VALUES ('00000000-0000-4000-8000-000000119205'::uuid),
           ('00000000-0000-4000-8000-000000119204'::uuid),
           ('00000000-0000-4000-8000-000000119203'::uuid)$$,
  'First page is sorted by created timestamp and user ID');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_users_page(
    _before_created_at => '2099-04-03',
    _before_user_id => '00000000-0000-4000-8000-000000119203', _page_size => 2)$$,
  $$VALUES ('00000000-0000-4000-8000-000000119202'::uuid),
           ('00000000-0000-4000-8000-000000119201'::uuid)$$,
  'Keyset cursor crosses a timestamp tie without duplicate');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_users_page(_role => 'operator')$$,
  $$VALUES ('00000000-0000-4000-8000-000000119204'::uuid),
           ('00000000-0000-4000-8000-000000119202'::uuid)$$,
  'Operator role takes precedence over a client role');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_users_page(_role => 'client')$$,
  $$VALUES ('00000000-0000-4000-8000-000000119203'::uuid)$$,
  'Client filter excludes elevated and unassigned users');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_users_page(_status => 'blocked')$$,
  $$VALUES ('00000000-0000-4000-8000-000000119204'::uuid)$$,
  'Status filter is evaluated before pagination');
SELECT results_eq(
  $$SELECT user_id FROM public.admin_list_users_page(_search => '%')$$,
  $$VALUES ('00000000-0000-4000-8000-000000119203'::uuid)$$,
  'Percent sign is searched literally');
SELECT is((SELECT role FROM public.admin_list_users_page(_search => 'No role')),
  NULL::text, 'Missing role is not reported as client');
SELECT * FROM finish();
ROLLBACK;
